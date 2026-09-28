/**
 * SHARING, MAIN'S HALF (YAZ-1799). Owns everything a renderer must never hold:
 * the Cloudflare API token, the Worker's upload password, and every HTTP call. Electron-free —
 * `fetch`, `secrets.ts`, `vaultConfig.ts` and a JSON file in userData — so it tests against a stub.
 *
 *  - `<userData>/sharing.json`: which account, bucket and Worker were provisioned, the
 *    workers.dev address and the custom domain. Not a secret, app-wide (the Cloudflare account
 *    is the user's, not a vault's), never broadcast in app state.
 *  - `secrets.json` (the secrets door): `cloudflareApiToken` + `shareUploadPassword`. The upload
 *    password is generated here and uploaded with the Worker as its secret binding; the user never sees it.
 *  - `<vault>/.yaseendraw/shares.json`: which boards are shared (`shareLinks.ts`).
 *
 * The app talks to Cloudflare's API only to set things up, attach a domain or delete everything
 * (`setup.ts`); sharing, updating and stopping talk to the user's own Worker with the upload
 * password (`boards.ts`). `config.ts` is what both share.
 */
import type { ShareAccount, ShareEntry, ShareListEntry, ShareSetupProgress, ShareStatus } from '@shared/types'
import { createBoards } from './boards'
import { createContext, type SharingDeps } from './config'
import { createSetup } from './setup'

export type { SharingConfig, SharingDeps } from './config'

export interface Sharing {
  status(): Promise<ShareStatus>
  /** Check a key and list the accounts it can see (the picker shows when there is more than one). */
  accounts(token: string): Promise<ShareAccount[]>
  setup(token: string, progress: (p: ShareSetupProgress) => void, accountId?: string): Promise<ShareStatus>
  get(root: string, path: string): Promise<ShareEntry | null>
  /** `check: false` skips the Worker's live check (no network) — the sidebar badges' call. */
  list(root: string, opts?: { check?: boolean }): Promise<ShareListEntry[]>
  /** A first share, or (with the `id` the board is shared under) a re-upload after a save. */
  publish(root: string, path: string, content: string, id?: string): Promise<ShareEntry>
  setPermission(root: string, path: string, allowDownload: boolean): Promise<ShareEntry>
  stop(root: string, path: string): Promise<void>
  /** A board (or folder) was renamed or moved inside the app: its shares follow. */
  relocate(roots: readonly string[], oldPath: string, newPath: string): Promise<void>
  /** A board (or folder) was deleted inside the app: its shares are stopped. */
  forget(roots: readonly string[], path: string): Promise<void>
  setDomain(hostname: string | null): Promise<ShareStatus>
  disconnect(root: string | null, deleteEverything: boolean): Promise<ShareStatus>
}

export function createSharing(deps: SharingDeps): Sharing {
  const ctx = createContext(deps)
  return { status: ctx.status, ...createSetup(ctx), ...createBoards(ctx) }
}
