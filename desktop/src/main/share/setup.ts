/**
 * Setting sharing up and taking it down (YAZ-1799): the only code that talks to Cloudflare's API —
 * check a key and list its accounts, provision (🔒 D1, reusing what is there — D11), claim a
 * workers.dev name (D17), attach a custom domain, and disconnect / delete everything. Every
 * refusal reaches the person in plain English (`explainCloudflareFailure`).
 */
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { CLOUDFLARE_TOKEN_SECRET, SHARE_UPLOAD_PASSWORD_SECRET, type ShareAccount, type ShareSetupProgress, type ShareSetupStep, type ShareStatus } from '@shared/types'
import { BridgeFailure } from '../fs/fsUtils'
import { requireAbsPath } from '../fs/validate'
import { CloudflareError, createCloudflareClient, STEP_PERMISSION, type CloudflareClient } from './cloudflare'
import { newShareId, type ShareContext, type SharingConfig } from './config'
import { updateShares } from './shareLinks'

export const WORKER_NAME = 'yaseen-draw-share'
export const BUCKET_NAME = 'yaseen-draw-shares'
const MAIN_MODULE = 'worker.js'
/** How long setup's test upload waits for a fresh workers.dev address to start answering. */
const TEST_PATIENCE_MS = 90_000
/** Tries at claiming a workers.dev subdomain whose name turns out to be taken (D17). */
const SUBDOMAIN_TRIES = 3
const HOSTNAME_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const KEY_REJECTED = "Cloudflare didn't accept this key. Check you copied all of it — or press Open Cloudflare and make a new one."

/**
 * Plain English for a Cloudflare refusal, written for someone who has never heard of R2.
 * `permission` is what the failed call needs, so a 403 can name it. Cloudflare's own wording never
 * reaches the person: an unmapped code keeps the client's "what failed (Cloudflare error N)".
 */
export function explainCloudflareFailure(err: unknown, permission: string): string {
  if (!(err instanceof CloudflareError)) return err instanceof Error ? err.message : String(err)
  if (err.code === 'OFFLINE') return err.message
  if (err.cfCode === 1000) return KEY_REJECTED
  if (err.cfCode === 10042)
    return "R2 (Cloudflare's file storage) isn't switched on for this account yet. Cloudflare asks for a payment card on file before it turns R2 on — sharing still stays inside the free tier ($0). Open https://dash.cloudflare.com/?to=/:account/r2/overview, add a card when asked, then press Set up again."
  if (err.cfCode === 10008)
    return 'The storage bucket still has shared boards in it, so Cloudflare would not delete it. Press Delete everything again to finish deleting them.'
  if (err.cfCode === 100117)
    return 'That address already has a DNS record (for example a CNAME) in Cloudflare. Delete that record in the Cloudflare dashboard (your domain › DNS › Records) or pick another name, then try again.'
  if (err.cfCode === 10000 || err.status === 403)
    return `This key is missing the “${permission}” permission. Press Open Cloudflare to make a new key (the page pre-fills every permission sharing needs) and paste that one.`
  return err.message
}

const SETUP_PERMISSION: Record<ShareSetupStep, string> = {
  verify: STEP_PERMISSION.account,
  account: STEP_PERMISSION.account,
  bucket: STEP_PERMISSION.bucket,
  viewer: STEP_PERMISSION.worker,
  worker: STEP_PERMISSION.worker,
  subdomain: STEP_PERMISSION.subdomain,
  test: STEP_PERMISSION.worker,
}

/** Plain English for a failed setup step. */
export function explainSetupFailure(step: ShareSetupStep, err: unknown): string {
  if (step === 'verify' && err instanceof CloudflareError && (err.status === 401 || err.status === 403)) return KEY_REJECTED
  return explainCloudflareFailure(err, SETUP_PERMISSION[step])
}

/** Runs one Cloudflare call of Settings' domain / disconnect actions; a refusal is rethrown in plain English. */
async function explained<T>(permission: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!(err instanceof CloudflareError)) throw err
    throw new BridgeFailure(err.code, explainCloudflareFailure(err, permission))
  }
}

/** `<account-slug>-<4 random [a-z0-9]>`: a workers.dev name nobody else is likely to hold (D17). */
export function subdomainFor(accountName: string): string {
  const slug = accountName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '') || 'yaseen-draw'
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  return `${slug}-${[...randomBytes(4)].map((b) => alphabet[b % alphabet.length]).join('')}`
}

export function createSetup(ctx: ShareContext) {
  const { deps, doFetch, now, sleep, readConfig, writeConfig, linkOrigin, worker, status } = ctx

  async function accounts(token: string): Promise<ShareAccount[]> {
    const cf = createCloudflareClient(token.trim(), deps.apiBase, doFetch)
    try {
      await cf.verifyToken()
      return await cf.listAccounts()
    } catch (err) {
      const message = explainSetupFailure('verify', err)
      throw new BridgeFailure(err instanceof BridgeFailure ? err.code : 'PROVIDER_FAILED', message)
    }
  }

  async function setup(token: string, progress: (p: ShareSetupProgress) => void, accountId?: string): Promise<ShareStatus> {
    const trimmed = token.trim()
    if (trimmed === '') throw new BridgeFailure('BAD_REQUEST', 'Paste your Cloudflare API key first.')
    const cf = createCloudflareClient(trimmed, deps.apiBase, doFetch)
    let step: ShareSetupStep = 'verify'
    const run = async <T>(s: ShareSetupStep, fn: () => Promise<T>, done?: (v: T) => string | undefined): Promise<T> => {
      step = s
      progress({ step: s, state: 'running' })
      const value = await fn()
      progress({ step: s, state: 'done', message: done?.(value) })
      return value
    }
    try {
      await run('verify', () => cf.verifyToken(), () => 'Key accepted')
      const account = await run(
        'account',
        async () => {
          const list = await cf.listAccounts()
          if (list.length === 0) throw new BridgeFailure('PROVIDER_FAILED', 'This key cannot see any Cloudflare account. Make the key under the account you want to use.')
          if (accountId !== undefined) {
            const picked = list.find((a) => a.id === accountId)
            if (picked === undefined) throw new BridgeFailure('BAD_REQUEST', 'That account is not visible to this key any more. Pick again.')
            return picked
          }
          // More than one account and none picked: the Settings page shows a picker first (D12).
          if (list.length > 1) throw new BridgeFailure('BAD_REQUEST', 'This key can see more than one Cloudflare account. Pick which one to use.')
          return list[0]
        },
        (a) => a.name,
      )
      const chosen = account.id
      // RECONNECT (D11): an existing bucket and Worker are REUSED, never recreated or emptied — after
      // "Forget key on this Mac" and a new setup, every old link is still there and manageable.
      // Each check runs inside its own step, so a refusal names that step's permission.
      await run(
        'bucket',
        async () => {
          const had = await cf.hasBucket(chosen, BUCKET_NAME)
          if (!had) await cf.createBucket(chosen, BUCKET_NAME)
          return had
        },
        (had) => (had ? `Found your existing ${BUCKET_NAME} — reusing it (nothing deleted)` : BUCKET_NAME),
      )
      const assets = await run(
        'viewer',
        async () => {
          const files = await deps.readAssets()
          return { jwt: await cf.uploadAssets(chosen, WORKER_NAME, files), count: files.length }
        },
        ({ count }) => `${count} files (the board viewers, their fonts and draw.io's shapes)`,
      )
      // Always a NEW upload password — on reconnect too: the old one was forgotten with the key. It
      // rides in the Worker upload as a secret binding. The code is re-uploaded either way so the
      // Worker matches this app; the stored boards are untouched.
      const password = randomBytes(32).toString('base64url')
      const hadWorker = await run(
        'worker',
        async () => {
          const had = await cf.hasWorker(chosen, WORKER_NAME)
          await cf.uploadWorker(chosen, WORKER_NAME, deps.modules, MAIN_MODULE, BUCKET_NAME, password, assets.jwt)
          return had
        },
        (had) => (had ? `Found your existing ${WORKER_NAME} — updated its code, kept its links` : WORKER_NAME),
      )
      // The token and password are kept from here on: every later step (and Stop / Delete everything) needs them.
      await deps.secrets.set(CLOUDFLARE_TOKEN_SECRET, trimmed)
      await deps.secrets.set(SHARE_UPLOAD_PASSWORD_SECRET, password)
      const workersDevUrl = await run(
        'subdomain',
        async () => {
          const sub = (await cf.getSubdomain(chosen)) ?? (await claimSubdomain(cf, chosen, account.name))
          await cf.enableWorkersDev(chosen, WORKER_NAME)
          return `https://${WORKER_NAME}.${sub}.workers.dev`
        },
        (url) => url,
      )
      const previous = await readConfig()
      // A custom domain already attached to the Worker comes back with it (reconnect).
      const attachedDomains = hadWorker ? await cf.listDomains(chosen, WORKER_NAME).catch(() => []) : []
      const customDomain = previous?.accountId === chosen && previous.customDomain !== null ? previous.customDomain : attachedDomains[0] !== undefined ? { hostname: attachedDomains[0].hostname, id: attachedDomains[0].id } : null
      const config: SharingConfig = { version: 1, accountId: chosen, accountName: account.name, bucketName: BUCKET_NAME, workerName: WORKER_NAME, workersDevUrl, customDomain, readyAt: now() }
      const origin = linkOrigin(config) as string
      await run('test', () => testRoundTrip(origin, password), () => 'Uploaded, read back and deleted a test file')
      await writeConfig(config)
      ctx.changed()
      return status()
    } catch (err) {
      const message = explainSetupFailure(step, err)
      progress({ step, state: 'failed', message })
      if (err instanceof BridgeFailure) throw new BridgeFailure(err.code, message)
      throw new BridgeFailure('PROVIDER_FAILED', message)
    }
  }

  /**
   * The account has no workers.dev subdomain yet (D17): claim `<account-slug>-xxxx`, a new random
   * suffix when the name is taken (10036). Any other refusal sends the person to the dashboard.
   */
  async function claimSubdomain(cf: CloudflareClient, accountId: string, accountName: string): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      const name = subdomainFor(accountName)
      try {
        await cf.claimSubdomain(accountId, name)
        return name
      } catch (err) {
        if (!(err instanceof CloudflareError) || err.code === 'OFFLINE' || err.cfCode === 10000 || err.status === 403) throw err
        if (err.cfCode === 10036 && attempt < SUBDOMAIN_TRIES) continue
        throw new BridgeFailure('PROVIDER_FAILED', "This Cloudflare account has no workers.dev address yet, and Cloudflare didn't let the app make one. Please claim a workers.dev subdomain in the Cloudflare dashboard (Workers & Pages), then run setup again.")
      }
    }
  }

  /**
   * A real upload, read-back and delete. A fresh workers.dev address can take a minute or more to
   * answer, so while it is unreachable (or not routed yet) this backs off — 1 s, 2 s, 4 s … 15 s —
   * for up to ~90 s.
   */
  async function testRoundTrip(origin: string, password: string): Promise<void> {
    const id = `setup-test-${newShareId()}`
    const body = JSON.stringify({ type: 'excalidraw', version: 2, source: 'yaseen-draw-setup-test', elements: [], appState: {}, files: {} })
    const deadline = now() + TEST_PATIENCE_MS
    for (let wait = 1_000; ; wait = Math.min(wait * 2, 15_000)) {
      try {
        const put = await worker(origin, 'PUT', `/api/boards/${id}`, password, body, { 'content-type': 'application/json', 'x-board-name': 'setup-test' })
        if (put.status === 401) throw new BridgeFailure('PROVIDER_FAILED', 'The Worker did not accept the upload password it was just given. Press Set up again.')
        if (put.ok) {
          const back = await worker(origin, 'GET', `/raw/${id}`, null)
          if (!back.ok || (await back.text()) !== body) throw new BridgeFailure('PROVIDER_FAILED', 'The test file did not read back the same.')
          await worker(origin, 'DELETE', `/api/boards/${id}`, password)
          return
        }
        // Anything else (404, 5xx) is a fresh address not routed to the Worker yet: wait and retry.
      } catch (err) {
        if (!(err instanceof CloudflareError && err.code === 'OFFLINE')) throw err
      }
      if (now() + wait > deadline)
        throw new BridgeFailure('OFFLINE', "Your new share address isn't answering yet. Cloudflare can take a minute or two to switch a new one on — press Set up again in a minute.")
      await sleep(wait)
    }
  }

  async function setDomain(hostname: string | null): Promise<ShareStatus> {
    const config = await readConfig()
    if (config === null) throw new BridgeFailure('NOT_SET_UP', 'Set up sharing first, then attach a domain.')
    const cf = await ctx.client()
    const domain = STEP_PERMISSION.domain
    if (hostname === null) {
      if (config.customDomain !== null) await explained(domain, () => cf.detachDomain(config.accountId, config.customDomain!.id))
      await writeConfig({ ...config, customDomain: null })
      ctx.changed()
      return status()
    }
    const host = hostname.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!HOSTNAME_RE.test(host)) throw new BridgeFailure('BAD_REQUEST', `“${hostname}” doesn't look like a domain. Type something like share.yourdomain.com.`)
    // The zone is the account's zone with the LONGEST name that the host ends with — so
    // share.example.co.uk finds example.co.uk, never co.uk, and a sub-zone beats its parent.
    const labels = host.split('.')
    let zone: { id: string; name: string; status: string } | null = null
    for (let i = 0; i <= labels.length - 2 && zone === null; i++) {
      const suffix = labels.slice(i).join('.')
      zone = await explained(domain, () => cf.findZone(config.accountId, suffix))
    }
    if (zone === null) throw new BridgeFailure('PROVIDER_FAILED', `${host} isn't under any domain on your Cloudflare account yet. Add the domain to Cloudflare first (the steps are below), wait until Cloudflare says it is Active, then try again.`)
    if (zone.status !== 'active')
      throw new BridgeFailure('PROVIDER_FAILED', `${zone.name} is on your Cloudflare account but isn't active yet — Cloudflare is still waiting for its nameservers to change at your registrar. Once the Cloudflare dashboard says it is Active (it can take a few hours), try again.`)
    // Attach the new domain BEFORE detaching the old one: a failure leaves the old address working.
    const attached = await explained(domain, () => cf.attachDomain(config.accountId, host, config.workerName, zone.id))
    await writeConfig({ ...config, customDomain: { hostname: host, id: attached.id } })
    ctx.changed()
    if (config.customDomain !== null && config.customDomain.hostname !== host) {
      // Links already point at the new domain; an old one left attached only still answers too.
      await cf.detachDomain(config.accountId, config.customDomain.id).catch((err) => console.warn(`[share] could not detach ${config.customDomain!.hostname}: ${String(err)}`))
    }
    return status()
  }

  /**
   * Forget the key and password on this computer; with `deleteEverything`, first wipe every shared
   * board, then the domain, the Worker and the bucket. Only `root`'s (the open vault's) shares.json
   * is cleared — another vault's records outlive their dead links until that vault is opened.
   */
  async function disconnect(root: string | null, deleteEverything: boolean): Promise<ShareStatus> {
    const vault = root === null ? null : requireAbsPath(root, 'root')
    const config = await readConfig()
    if (deleteEverything && config !== null) {
      const password = await deps.secrets.read(SHARE_UPLOAD_PASSWORD_SECRET)
      const origin = linkOrigin(config)
      // The Worker deletes one page (≤1,000 objects) per request, so one request stays under the
      // free plan's subrequest cap; it answers `done` once the bucket is empty.
      for (let done = password === null || origin === null; !done; ) {
        const res = await worker(origin!, 'POST', '/api/wipe', password)
        if (!res.ok) throw new BridgeFailure('PROVIDER_FAILED', `Could not delete the shared boards (HTTP ${res.status}); nothing was disconnected. Try again.`)
        done = ((await res.json().catch(() => ({}))) as { done?: unknown }).done !== false
      }
      const cf = await ctx.client()
      if (config.customDomain !== null) await explained(STEP_PERMISSION.domain, () => cf.detachDomain(config.accountId, config.customDomain!.id))
      await explained(STEP_PERMISSION.worker, () => cf.deleteWorker(config.accountId, config.workerName))
      await explained(STEP_PERMISSION.bucket, () => cf.deleteBucket(config.accountId, config.bucketName))
      // Everything on Cloudflare is gone by now, so an unreadable shares.json must not stop the disconnect.
      if (vault !== null)
        await updateShares(vault, (shares) => {
          const keys = Object.keys(shares)
          for (const key of keys) delete shares[key]
          return keys.length > 0
        }).catch((err) => console.warn(`[share] could not clear ${vault}'s shares.json: ${String(err)}`))
    }
    await deps.secrets.set(CLOUDFLARE_TOKEN_SECRET, null)
    await deps.secrets.set(SHARE_UPLOAD_PASSWORD_SECRET, null)
    await rm(deps.configFile, { force: true })
    ctx.changed()
    return status()
  }

  return { accounts, setup, setDomain, disconnect }
}
