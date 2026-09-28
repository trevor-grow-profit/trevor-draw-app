/**
 * SHARE LINK (YAZ-1799): one board, uploaded to the user's OWN Cloudflare (one R2
 * bucket + one small Worker), reachable by anyone with its long random link. ALWAYS LIVE
 * (🔒 YAZ-1799 D3): every save of a shared board re-uploads it to the same link (`liveShare.ts`).
 *
 * WHO OWNS WHAT:
 *  - MAIN owns Cloudflare: the API token and the Worker's upload password live in `secrets.json`
 *    (the secrets door — the renderer can never read either), and every HTTP call is main's.
 *  - The RENDERER assembles the bytes (the same standalone `.excalidraw` Export Drawing writes,
 *    🔒 YAZ-1799 D3) because only it has the engine; it hands them to main to upload.
 *  - The vault remembers which boards are shared in `<vault>/.yaseendraw/shares.json`:
 *    `{ version: 1, shares: { "<vault-relative path>": { id, allowDownload, sharedAt, updatedAt } } }`.
 *  - ONE LINK per board, `/b/<id>`, plus a permission the owner flips on that same link (the
 *    Google Docs model): "can view and download" (default) or "can view only". The Worker
 *    enforces it — `/raw/<id>` is 403 when downloads are off.
 */

/**
 * The Workers free-plan request body limit — the Worker enforces it and main pre-checks it,
 * so a board over it is refused with an explanation instead of a failed upload. Decimal megabytes,
 * as Cloudflare states the limit.
 */
export const MAX_SHARE_BYTES = 100 * 1000 * 1000

/** The two secrets sharing keeps in `secrets.json`. Neither ever reaches a renderer. */
export const CLOUDFLARE_TOKEN_SECRET = 'cloudflareApiToken'
export const SHARE_UPLOAD_PASSWORD_SECRET = 'shareUploadPassword'

/** What Settings › Sharing shows at the top. Holds no secret. */
export interface ShareStatus {
  state: 'off' | 'ready'
  /** The public origin links are built on: the custom domain when attached, else workers.dev. */
  url: string | null
  /** The workers.dev address, even when a custom domain is attached. */
  workersDevUrl: string | null
  customDomain: string | null
  accountName: string | null
  workerName: string | null
  bucketName: string | null
  readyAt: number | null
  /** True when this build talks to the local fake Cloudflare (the demo). */
  demo: boolean
}

/** The setup flow's steps, in order — the progress list renders exactly these. */
export const SHARE_SETUP_STEPS = ['verify', 'account', 'bucket', 'viewer', 'worker', 'subdomain', 'test'] as const
export type ShareSetupStep = (typeof SHARE_SETUP_STEPS)[number]

export const SHARE_SETUP_LABELS: Record<ShareSetupStep, string> = {
  verify: 'Checking the key',
  account: 'Finding your Cloudflare account',
  bucket: 'Creating the storage bucket (R2)',
  viewer: 'Uploading the viewer page',
  worker: 'Uploading the share Worker and its upload password',
  subdomain: 'Turning on the workers.dev address',
  test: 'Test upload',
}

export interface ShareSetupProgress {
  step: ShareSetupStep
  state: 'running' | 'done' | 'failed'
  /** Plain-English detail: what was found, or what went wrong and what to do about it. */
  message?: string
}

/**
 * Where a shared board's ALWAYS-LIVE link stands (Yasin's amendment): every save re-uploads, so
 * the interesting facts are "is an upload running" and "did the last one fail, and why". Kept by
 * main in memory — a relaunch starts from `ok`, and the next save tells the truth again.
 */
export interface ShareSync {
  state: 'ok' | 'uploading' | 'failed'
  /** The last failure, in plain English. */
  message?: string
  /** When the last failure happened. */
  failedAt?: number
}

/** One board's share record as the renderer sees it. `path` is absolute. */
export interface ShareEntry {
  path: string
  id: string
  /** `/b/<id>` on the share origin. */
  url: string
  /** "can view and download" (true, the default for a new share) or "can view only" (false). */
  allowDownload: boolean
  sharedAt: number
  /** When the link last got a successful upload. */
  updatedAt: number
  sync: ShareSync
  /** The Worker last answered 404 for this link (a Settings check or a permission change): its copy is gone until the next save puts it back. */
  stale: boolean
}

/** A Settings list row: the record plus whether the board is still at its path. Whether the link is still live is `stale` (a checked list sets it). */
export interface ShareListEntry extends ShareEntry {
  fileExists: boolean
}

export interface ShareBoardRequest {
  root: string
  path: string
}

export interface SharePublishRequest extends ShareBoardRequest {
  /** The standalone `.excalidraw` text (images embedded), or a diagram's `.drawio` XML (🔒 YAZ-1802 D11). */
  content: string
  /**
   * A re-upload's link: main finds the record by it even if a rename moved the board since the
   * save, and refuses (NOT_FOUND) if it was stopped. Absent: share `path` (or re-upload it if shared).
   */
  id?: string
}

export interface SharePermissionRequest extends ShareBoardRequest {
  allowDownload: boolean
}

