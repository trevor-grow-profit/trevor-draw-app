#!/usr/bin/env node
/**
 * USAGE: node tools/fakeCloudflare.mjs --data <dir> [--port 8787]   (--port 0 picks any free port)
 *
 * A LOCAL, FAKE Cloudflare for share links (YAZ-1799). Nothing here talks to the
 * real Cloudflare. One port serves two things:
 *
 *  1. /client/v4/…  — ONLY the handful of Cloudflare API endpoints the app's "Set up sharing" flow
 *     calls (verify token, list accounts, create/delete an R2 bucket, upload/delete a Worker with its
 *     secret binding, the workers.dev subdomain, zones + custom domains), answering with Cloudflare's
 *     real error codes. Point the app at it with
 *     `YASEEN_DRAW_CLOUDFLARE_API=http://127.0.0.1:<port>/client/v4`.
 *  2. everything else — the share Worker's own routes (/b/:id, /scene/…, /raw/…, /api/…), answered by
 *     running the SAME `share/worker.js` handler against a disk-backed fake R2 bucket in
 *     `<data>/bucket/`. Point the app's links at it with `YASEEN_DRAW_SHARE_ORIGIN=http://localhost:<port>`.
 *
 * MAGIC TOKENS (paste them in Settings › Sharing): the one list is TOKEN_PAGE below — the page
 * "Open Cloudflare" shows in the demo. Any other token is rejected. Stop this process to test the
 * offline case.
 *
 * Extra pages: /__fake/token-page (what "Open Cloudflare" shows in the demo), /__fake/state (JSON).
 * Custom domains: the account's zones are yasin.dev, example.com, example.co.uk and yaseendraw.app
 * (so share.yasin.dev and share.example.co.uk attach; share.missingzone.com is "not on your account"),
 * plus pending-zone.dev, still pending (share.pending-zone.dev is "not active yet"). cname.yasin.dev
 * already has a DNS record, so attaching it is refused (100117).
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { handle as workerHandle } from '../share/worker.js'
import { excalidrawFontsDir } from './lib/excalidrawFonts.mjs'
import { DRAWIO_TAG } from './packDrawio.mjs'

const USAGE = 'usage: node tools/fakeCloudflare.mjs --data <dir> [--port 8787] (0 = any free port)'
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : (args[i + 1] ?? '')
}
const DATA = flag('--data') && path.resolve(flag('--data'))
const PORT = Number(flag('--port') ?? 8787)
if (!DATA) {
  console.error(USAGE)
  process.exit(2)
}
const BUCKET_DIR = path.join(DATA, 'bucket')
const ASSET_DIR = path.join(DATA, 'assets')
/** The repo's built viewer — what an account that already had the Worker (board 10's) serves before any setup ran here. */
const REPO_ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'share', 'dist', 'assets')
/** The app's draw.io webapp: share setup publishes its viewer files under `/assets/drawio/` (🔒 YAZ-1802 D5). */
const REPO_DRAWIO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', '.cache', 'drawio', DRAWIO_TAG)
const STATE_FILE = path.join(DATA, 'state.json')
fs.mkdirSync(BUCKET_DIR, { recursive: true })
fs.mkdirSync(ASSET_DIR, { recursive: true })

const ACCOUNT = { id: 'f00dfeedc0ffee0000demo0account01', name: "Yasin's Account (demo)" }
const SECOND_ACCOUNT = { id: 'f00dfeedc0ffee0000demo0account02', name: 'GrowProfit (demo)' }
/** The zones every demo account holds (custom domains must end with one of these; the longest match wins). */
const ZONES = [...['yasin.dev', 'example.com', 'example.co.uk', 'yaseendraw.app'].map((name) => ({ name, status: 'active' })), { name: 'pending-zone.dev', status: 'pending' }].map((z) => ({ id: `zone-${z.name.replace(/\W/g, '-')}`, ...z }))
/** A hostname that already has a DNS record: Cloudflare refuses to attach a Worker to it. */
const CNAME_HOST = 'cname.yasin.dev'
const SUBDOMAIN = 'yasin-demo'
const TOKENS = new Set(['demo-good', 'demo-invalid', 'demo-bad-perms', 'demo-no-card', 'demo-slow', 'demo-two-accounts', 'cfat_demo-good', 'demo-no-subdomain', 'demo-subdomain-taken'])
/** The workers.dev subdomain each no-subdomain token has claimed (this run only), and whether the "taken" one was refused yet. */
const claimed = new Map()
let refusedTakenClaim = false

// ------------------------------------------------------------------ persisted fake-account state
const emptyState = () => ({ buckets: [], scripts: {}, domains: [], assetSessions: {} })
function loadState() {
  try {
    return { ...emptyState(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }
  } catch {
    return emptyState()
  }
}
let state = loadState()
const saveState = () => fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)

// ------------------------------------------------------------------ disk-backed R2-shaped bucket
const objectFile = (key) => path.join(BUCKET_DIR, encodeURIComponent(key))
const metaFile = (key) => `${objectFile(key)}.meta.json`
const readMeta = (key) => {
  try {
    return JSON.parse(fs.readFileSync(metaFile(key), 'utf8'))
  } catch {
    return null
  }
}
async function toBuffer(body) {
  if (body === null || body === undefined) return Buffer.alloc(0)
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  return Buffer.from(await new Response(body).arrayBuffer())
}
const R2_PAGE = 1000
const diskBucket = {
  async put(key, body, opts = {}) {
    const bytes = await toBuffer(body)
    fs.writeFileSync(objectFile(key), bytes)
    const meta = { key, size: bytes.length, uploaded: new Date().toISOString(), httpMetadata: opts.httpMetadata ?? {}, customMetadata: opts.customMetadata ?? {} }
    fs.writeFileSync(metaFile(key), JSON.stringify(meta))
    return meta
  },
  async head(key) {
    if (!fs.existsSync(objectFile(key))) return null
    return readMeta(key) ?? { key, size: fs.statSync(objectFile(key)).size, customMetadata: {} }
  },
  async get(key) {
    const meta = await this.head(key)
    if (meta === null) return null
    return { ...meta, body: Readable.toWeb(fs.createReadStream(objectFile(key))), text: async () => fs.readFileSync(objectFile(key), 'utf8') }
  },
  /** One key or up to 1,000, as R2 takes them. */
  async delete(keys) {
    const list = Array.isArray(keys) ? keys : [keys]
    if (list.length > R2_PAGE) throw new Error(`R2 deletes at most ${R2_PAGE} keys per call`)
    for (const key of list) {
      fs.rmSync(objectFile(key), { force: true })
      fs.rmSync(metaFile(key), { force: true })
    }
  },
  /** At most 1,000 keys per page in key order; `cursor` continues after the last key of the previous page, as R2 pages. */
  async list({ prefix = '', cursor, limit = R2_PAGE } = {}) {
    const keys = fs
      .readdirSync(BUCKET_DIR)
      .filter((f) => !f.endsWith('.meta.json'))
      .map((f) => decodeURIComponent(f))
      .filter((k) => k.startsWith(prefix) && (cursor === undefined || k > cursor))
      .sort()
    const page = keys.slice(0, Math.min(limit, R2_PAGE))
    const truncated = keys.length > page.length
    return { objects: page.map((key) => ({ key })), truncated, cursor: truncated ? page[page.length - 1] : undefined }
  },
}

const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain' }
/**
 * The `ASSETS` binding (Workers Static Assets): the uploaded manifest's files, by path. Before any
 * setup uploaded them (board 10's pre-existing link), the repo's `share/dist/assets` stands in, with
 * the package's fonts and the pack cache for what setup would have added under `/assets/fonts/` and
 * `/assets/drawio/`.
 */
const assetsBinding = (manifest) => ({
  async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname)
    let file = null
    if (manifest !== undefined) {
      const hash = manifest[pathname]?.hash
      if (hash !== undefined) file = path.join(ASSET_DIR, hash)
    } else if (pathname.startsWith('/assets/')) {
      const candidate = path.resolve(REPO_ASSETS, `.${pathname.slice('/assets'.length)}`)
      if (candidate.startsWith(`${REPO_ASSETS}/`)) file = candidate
      const drawio = path.resolve(REPO_DRAWIO, `.${pathname.slice('/assets/drawio'.length)}`)
      if (pathname.startsWith('/assets/drawio/') && !fs.existsSync(candidate) && drawio.startsWith(`${REPO_DRAWIO}/`)) file = drawio
      if (pathname.startsWith('/assets/fonts/')) {
        // Excalidraw's own fonts: share setup publishes the app's copy of them here (YAZ-2073 3C).
        const fonts = excalidrawFontsDir()
        const font = path.resolve(fonts, `.${pathname.slice('/assets/fonts'.length)}`)
        if (font.startsWith(`${fonts}/`)) file = font
      }
    }
    if (file === null || !fs.existsSync(file)) return new Response('not found', { status: 404 })
    const type = MIME[path.extname(pathname)] ?? 'application/octet-stream'
    return new Response(Readable.toWeb(fs.createReadStream(file)), { headers: { 'content-type': type, 'cache-control': 'public, max-age=3600' } })
  },
})

/** The Worker's env: the bucket always (so pre-seeded demo links work before setup), the secret once one was set. */
const workerEnv = () => {
  const script = Object.values(state.scripts)[0]
  return { BUCKET: diskBucket, UPLOAD_PASSWORD: script?.secrets?.UPLOAD_PASSWORD, ASSETS: assetsBinding(script?.assets) }
}

// ------------------------------------------------------------------ Cloudflare API envelope helpers
const cf = (res, status, result, errors = []) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ success: errors.length === 0, errors, messages: [], result }))
}
const cfError = (res, status, code, message) => cf(res, status, null, [{ code, message }])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

async function api(req, res, url) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
  const route = url.pathname.replace(/^\/client\/v4/, '')
  const log = (what) => console.log(`[api] ${req.method} ${route} token=${token || '-'} → ${what}`)
  if (token === 'demo-slow') await sleep(1500)
  const isAssetSession = token.startsWith('demo-assets-') && state.assetSessions[token] !== undefined
  if (!isAssetSession && (!TOKENS.has(token) || token === 'demo-invalid')) {
    log('401 invalid token')
    return cfError(res, 401, 1000, 'Invalid API Token')
  }
  const m = (re) => route.match(re)
  let r

  if (req.method === 'GET' && route === '/user/tokens/verify') {
    if (token.startsWith('cfat_')) {
      log('401 an account token is not a user token')
      return cfError(res, 401, 1000, 'Invalid API Token')
    }
    log('active')
    return cf(res, 200, { id: `tok-${token}`, status: 'active' })
  }
  if (m(/^\/accounts\/([^/]+)\/tokens\/verify$/) && req.method === 'GET') {
    log('active (account token)')
    return cf(res, 200, { id: `tok-${token}`, status: 'active' })
  }
  if (req.method === 'GET' && route === '/accounts') {
    if (token === 'demo-two-accounts') {
      log('2 accounts')
      return cf(res, 200, [ACCOUNT, SECOND_ACCOUNT])
    }
    log('1 account')
    return cf(res, 200, [ACCOUNT])
  }
  // Every R2 call — the existence check included — is refused for these two, as Cloudflare does.
  if (m(/^\/accounts\/([^/]+)\/r2\//) && token === 'demo-bad-perms') {
    log('403 bad perms')
    return cfError(res, 403, 10000, 'Authentication error')
  }
  if (m(/^\/accounts\/([^/]+)\/r2\//) && token === 'demo-no-card') {
    log('403 R2 not enabled')
    return cfError(res, 403, 10042, 'Please enable R2 through the Cloudflare Dashboard.')
  }
  if ((r = m(/^\/accounts\/([^/]+)\/r2\/buckets$/)) && req.method === 'POST') {
    const { name } = JSON.parse((await readBody(req)).toString() || '{}')
    if (state.buckets.includes(name)) {
      log('409 exists')
      return cfError(res, 409, 10073, 'The bucket you tried to create already exists, and you own it.')
    }
    state.buckets.push(name)
    saveState()
    log(`created bucket ${name}`)
    return cf(res, 200, { name, creation_date: new Date().toISOString() })
  }
  if ((r = m(/^\/accounts\/([^/]+)\/r2\/buckets\/([^/]+)$/)) && req.method === 'GET') {
    const name = decodeURIComponent(r[2])
    const found = state.buckets.includes(name)
    log(found ? `bucket ${name} exists` : `no bucket ${name}`)
    return found ? cf(res, 200, { name }) : cfError(res, 404, 10006, 'The specified bucket does not exist.')
  }
  if (m(/^\/accounts\/([^/]+)\/workers\/scripts$/) && req.method === 'GET') {
    log(`${Object.keys(state.scripts).length} scripts`)
    return cf(res, 200, Object.keys(state.scripts).map((id) => ({ id })))
  }
  if (m(/^\/accounts\/([^/]+)\/workers\/domains$/) && req.method === 'GET') {
    const service = url.searchParams.get('service')
    const list = state.domains.filter((d) => service === null || d.service === service)
    log(`${list.length} domains`)
    return cf(res, 200, list)
  }
  if ((r = m(/^\/accounts\/([^/]+)\/r2\/buckets\/([^/]+)$/)) && req.method === 'DELETE') {
    const name = decodeURIComponent(r[2])
    if ((await diskBucket.list()).objects.length > 0) {
      log('409 not empty')
      return cfError(res, 409, 10008, 'The bucket you tried to delete is not empty.')
    }
    state.buckets = state.buckets.filter((b) => b !== name)
    saveState()
    log(`deleted bucket ${name}`)
    return cf(res, 200, {})
  }
  if ((r = m(/^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)$/)) && req.method === 'PUT') {
    const name = decodeURIComponent(r[2])
    const body = await readBody(req)
    const form = await new Request('http://x', { method: 'PUT', headers: { 'content-type': req.headers['content-type'] }, body }).formData()
    const metaPart = form.get('metadata')
    const metadata = JSON.parse(metaPart === null ? '{}' : typeof metaPart === 'string' ? metaPart : await metaPart.text())
    const modules = [...form.keys()].filter((k) => k !== 'metadata')
    const previous = state.scripts[name]
    // Static assets arrive as a completion token from the upload session; it names the manifest.
    const assets = metadata.assets?.jwt !== undefined ? state.assetSessions[metadata.assets.jwt] : previous?.assets
    // Secrets arrive as `secret_text` bindings in the same upload.
    const secrets = Object.fromEntries((metadata.bindings ?? []).filter((b) => b.type === 'secret_text').map((b) => [b.name, b.text]))
    state.scripts[name] = { metadata: { ...metadata, bindings: (metadata.bindings ?? []).map((b) => (b.type === 'secret_text' ? { ...b, text: '(hidden)' } : b)) }, modules, secrets, subdomain: previous?.subdomain ?? false, assets, uploadedAt: new Date().toISOString() }
    saveState()
    log(`uploaded worker ${name} (${modules.join(', ')})`)
    return cf(res, 200, { id: name, etag: `demo-${Date.now()}` })
  }
  if ((r = m(/^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)$/)) && req.method === 'DELETE') {
    delete state.scripts[decodeURIComponent(r[2])]
    saveState()
    log('deleted worker')
    return cf(res, 200, null)
  }
  if ((r = m(/^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/assets-upload-session$/)) && req.method === 'POST') {
    const { manifest } = JSON.parse((await readBody(req)).toString())
    const missing = [...new Set(Object.values(manifest).map((e) => e.hash))].filter((h) => !fs.existsSync(path.join(ASSET_DIR, h)))
    const jwt = `demo-assets-${Date.now()}-${Math.random().toString(36).slice(2)}`
    state.assetSessions[jwt] = manifest
    saveState()
    // Cloudflare batches the missing files into buckets; 50 per bucket here.
    const buckets = []
    for (let i = 0; i < missing.length; i += 50) buckets.push(missing.slice(i, i + 50))
    log(`assets session: ${Object.keys(manifest).length} files, ${missing.length} to upload`)
    return cf(res, 200, { jwt, buckets })
  }
  if (m(/^\/accounts\/([^/]+)\/workers\/assets\/upload$/) && req.method === 'POST') {
    const body = await readBody(req)
    const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body }).formData()
    let n = 0
    for (const [hash, value] of form.entries()) {
      const b64 = typeof value === 'string' ? value : await value.text()
      fs.writeFileSync(path.join(ASSET_DIR, hash), Buffer.from(b64, 'base64'))
      n++
    }
    log(`assets upload: ${n} files`)
    // The session token doubles as the completion token in this fake.
    return cf(res, 201, { jwt: token })
  }
  if (m(/^\/accounts\/([^/]+)\/workers\/subdomain$/) && req.method === 'GET') {
    const noSubdomain = token === 'demo-no-subdomain' || token === 'demo-subdomain-taken'
    const sub = noSubdomain ? claimed.get(token) : SUBDOMAIN
    if (sub === undefined) {
      log('10007 no workers.dev subdomain yet')
      return cfError(res, 404, 10007, 'This account does not have a workers.dev subdomain.')
    }
    log(`subdomain ${sub}`)
    return cf(res, 200, { subdomain: sub })
  }
  if (m(/^\/accounts\/([^/]+)\/workers\/subdomain$/) && req.method === 'PUT') {
    const { subdomain } = JSON.parse((await readBody(req)).toString())
    if (token === 'demo-subdomain-taken' && !refusedTakenClaim) {
      refusedTakenClaim = true
      log(`10036 ${subdomain} is taken`)
      return cfError(res, 409, 10036, 'Subdomain is unavailable.')
    }
    claimed.set(token, subdomain)
    log(`claimed subdomain ${subdomain}`)
    return cf(res, 200, { subdomain })
  }
  if ((r = m(/^\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/subdomain$/)) && req.method === 'POST') {
    const script = state.scripts[decodeURIComponent(r[2])]
    if (script === undefined) return cfError(res, 404, 10007, 'This Worker does not exist on your account.')
    script.subdomain = true
    saveState()
    log('workers.dev enabled')
    return cf(res, 200, { enabled: true })
  }
  if (route === '/zones' && req.method === 'GET') {
    const name = url.searchParams.get('name')
    const found = ZONES.filter((z) => name === null || z.name === name)
    log(`${found.length} zones named ${name}`)
    return cf(res, 200, found)
  }
  if (m(/^\/accounts\/([^/]+)\/workers\/domains$/) && req.method === 'PUT') {
    const { hostname, service, zone_id } = JSON.parse((await readBody(req)).toString())
    if (hostname === CNAME_HOST) {
      log('409 existing DNS record')
      return cfError(res, 409, 100117, "Hostname already has externally managed DNS records (A, CNAME, etc). Either delete them, try a different hostname, or use the option 'override_existing_dns_record' to override.")
    }
    const id = `dom-${hostname.replace(/\W/g, '-')}`
    state.domains = [...state.domains.filter((d) => d.hostname !== hostname), { id, hostname, service, zone_id }]
    saveState()
    log(`custom domain ${hostname} → ${service}`)
    return cf(res, 200, { id, hostname, service, zone_id })
  }
  if ((r = m(/^\/accounts\/([^/]+)\/workers\/domains\/([^/]+)$/)) && req.method === 'DELETE') {
    state.domains = state.domains.filter((d) => d.id !== decodeURIComponent(r[2]))
    saveState()
    log('custom domain removed')
    return cf(res, 200, null)
  }
  log('404 not faked')
  return cfError(res, 404, 7003, `Not faked by tools/fakeCloudflare.mjs: ${req.method} ${route}`)
}

const TOKEN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fake Cloudflare — API tokens</title>
<style>body{font:15px/1.5 -apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#222}code{background:#f2f2f5;padding:2px 6px;border-radius:4px;font-size:14px}li{margin:10px 0}.box{border:1px solid #f5a623;background:#fff8ec;padding:12px 16px;border-radius:8px}</style></head>
<body><h1>Fake Cloudflare — create API token</h1>
<p class="box">This is the DEMO stand-in for <b>dash.cloudflare.com/profile/api-tokens</b>. In the real app this button opens Cloudflare with a pre-filled token template (Workers Scripts: Edit, Workers R2 Storage: Edit, Account Settings: Read, Zone: Read, Workers Routes: Edit). Copy one of these magic tokens and paste it back into Trevor Draw:</p>
<ul>
<li><code>demo-good</code> — everything succeeds</li>
<li><code>demo-slow</code> — succeeds, ~1.5 s per step (watch the progress list)</li>
<li><code>demo-invalid</code> — Cloudflare rejects the token (so does any token not listed here)</li>
<li><code>demo-bad-perms</code> — token lacks the R2 permission</li>
<li><code>demo-no-card</code> — R2 not enabled yet (needs a card on file)</li>
<li><code>demo-two-accounts</code> — the key sees two accounts (a picker appears)</li>
<li><code>cfat_demo-good</code> — an account-owned key (/user/tokens/verify refuses it, its account's verify accepts it); succeeds</li>
<li><code>demo-no-subdomain</code> — no workers.dev subdomain yet (10007); setup claims one</li>
<li><code>demo-subdomain-taken</code> — like the above, but the first name is taken (10036); setup retries</li>
</ul></body></html>`

async function onRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `localhost:${PORT}`}`)
  try {
    if (url.pathname.startsWith('/client/v4/')) return await api(req, res, url)
    if (url.pathname === '/__fake/token-page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(TOKEN_PAGE)
    }
    if (url.pathname === '/__fake/state') {
      state = loadState()
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ ...state, objects: (await diskBucket.list()).objects }, null, 2))
    }
    // Everything else is the share Worker, run exactly as Cloudflare would run it.
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)
    const request = new Request(url, { method: req.method, headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'), body })
    const response = await workerHandle(request, workerEnv())
    console.log(`[worker] ${req.method} ${url.pathname} → ${response.status}${body ? ` (${body.length} bytes)` : ''}`)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    if (response.body === null || req.method === 'HEAD') return res.end()
    Readable.fromWeb(response.body).pipe(res)
  } catch (err) {
    console.error('[fake] error', err)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(String(err))
  }
}
// Loopback only, on BOTH stacks: `localhost` may resolve to ::1 or 127.0.0.1 depending on the client.
// 127.0.0.1 comes first and is required: if it cannot listen the fake exits at once rather than idling
// half-up. `--port 0` lets it pick a free port itself (the tests do this, so no port is ever probed and
// then re-bound); ::1 then follows on the same port, best effort, as before.
function listen(host, port, required) {
  const server = http.createServer(onRequest)
  server.requestTimeout = 0
  server.on('error', (err) => {
    console.error(`[fake] cannot listen on ${host}:${port}: ${err.message}`)
    if (required) process.exit(1)
  })
  server.listen(port, host, () => {
    const bound = server.address().port
    console.log(`fake Cloudflare on http://${host.includes(':') ? `[${host}]` : host}:${bound} (data ${DATA}) — ${fileURLToPath(import.meta.url)}`)
    if (required) listen('::1', bound, false)
  })
}
listen('127.0.0.1', PORT, true)
