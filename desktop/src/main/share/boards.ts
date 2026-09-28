/**
 * The shared boards themselves (YAZ-1799): which boards a vault shares (`shares.json`), their
 * links, uploads (🔒 D3 always live — every save re-uploads), the download permission (D15/D16's
 * `perm/<id>`), stopping, and following in-app renames and deletes (D10). Talks only to the
 * user's own Worker, with the upload password.
 */
import { stat } from 'node:fs/promises'
import { boardBaseName, isDiagram } from '@shared/fileKind'
import { isWithin } from '@shared/paths'
import { MAX_SHARE_BYTES, type ShareEntry, type ShareListEntry, type ShareSync } from '@shared/types'
import { BridgeFailure, requireAbsPath } from '../fs/fsUtils'
import { uploadTimeoutMs } from './cloudflare'
import { newShareId, PASSWORD_REFUSED, type ShareContext } from './config'
import { absFromKey, readShares, relKey, updateShares, type ShareRecord } from './shareLinks'

const LIVE_CHECK_MS = 5_000
const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`
const stripName = (p: string): string => boardBaseName(p.split('/').pop()!)
/** 🔒 YAZ-1802 D11: a share Worker deployed before diagrams could be shared (it answers a diagram's upload without `x-board-kind`). */
export const WORKER_OUTDATED = "Your share Worker is from before diagrams could be shared, so it can't show this one. Open Settings › Sharing and run Set up sharing again: it updates the Worker, and every link keeps working."
/** The open vault holding `abs` — the deepest one, if vaults nest. */
const rootOf = (roots: readonly string[], abs: string) => [...roots].filter((r) => isWithin(r, abs, true)).sort((a, b) => b.length - a.length)[0] ?? null

export function createBoards(ctx: ShareContext) {
  const { now, readConfig, linkOrigin, ready, worker } = ctx
  /**
   * Each shared board's live-link state, keyed by share id — the id survives a rename, a path does
   * not (ALWAYS-LIVE, D3). Memory only: an upload in flight or a failure is a fact about THIS run;
   * the next save re-tells it.
   */
  const syncs = new Map<string, ShareSync>()
  const setSync = (id: string, sync: ShareSync | null) => {
    if (sync === null) syncs.delete(id)
    else syncs.set(id, sync)
    ctx.changed()
  }
  /**
   * Ids the Worker last answered 404 for (the Settings check, or a permission change): the record
   * is here but its copy is gone. The next save re-creates it on the same id — and because that
   * PUT is a create on the Worker, it is the one re-upload that carries the permission.
   */
  const stale = new Set<string>()

  const toEntry = (root: string, key: string, rec: ShareRecord, origin: string | null): ShareEntry => ({
    path: absFromKey(root, key),
    id: rec.id,
    url: origin === null ? '' : `${origin}/b/${rec.id}`,
    allowDownload: rec.allowDownload,
    sharedAt: rec.sharedAt,
    updatedAt: rec.updatedAt,
    sync: syncs.get(rec.id) ?? { state: 'ok' },
    stale: stale.has(rec.id),
  })
  const entryFor = async (root: string, key: string, rec: ShareRecord) => toEntry(root, key, rec, linkOrigin(await readConfig()))
  const board = (root: string, path: string) => {
    const r = requireAbsPath(root, 'root')
    return { r, key: relKey(r, requireAbsPath(path, 'path')) }
  }

  async function get(root: string, path: string): Promise<ShareEntry | null> {
    const { r, key } = board(root, path)
    const rec = (await readShares(r))[key]
    return rec === undefined ? null : entryFor(r, key, rec)
  }

  /**
   * Every share in the vault, newest first. `check` (Settings) also asks the Worker whether each
   * link is still live — one HEAD per share, which sets `stale`; the sidebar badges pass
   * `check: false` and send none.
   */
  async function list(root: string, { check = true }: { check?: boolean } = {}): Promise<ShareListEntry[]> {
    const r = requireAbsPath(root, 'root')
    const shares = await readShares(r)
    const origin = linkOrigin(await readConfig())
    const rows = await Promise.all(
      Object.entries(shares).map(async ([key, rec]): Promise<ShareListEntry> => {
        const fileExists = await stat(absFromKey(r, key)).then((s) => s.isFile(), () => false)
        if (check && origin !== null) {
          // `/scene`, not `/raw`: a view-only board answers 403 on `/raw` and would read as broken.
          // A 404 marks the link stale, a 200 clears it; anything else (offline, 5xx) leaves it as it was.
          const res = await ctx.doFetch(`${origin}/scene/${rec.id}`, { method: 'HEAD', signal: AbortSignal.timeout(LIVE_CHECK_MS) }).catch(() => null)
          if (res?.status === 404) stale.add(rec.id)
          else if (res?.status === 200) stale.delete(rec.id)
        }
        return { ...toEntry(r, key, rec, origin), fileExists }
      }),
    )
    return rows.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * First share, or an automatic re-upload after a save. Every outcome of a board that is ALREADY
   * shared is recorded in `syncs` (uploading → ok | failed + reason) so the Share dialog and the
   * Settings list can say "Up to date", "Uploading…" or "Couldn't update: …". The record in
   * shares.json is kept on failure — the next save retries.
   *
   * A re-upload names the link (`id`) it is for, and lands on that record wherever an in-app
   * rename has moved it since the save; if the board was stopped meanwhile it is refused, never
   * quietly shared again under a new link.
   */
  async function publish(root: string, path: string, content: string, id?: string): Promise<ShareEntry> {
    const { r, key } = board(root, path)
    const shares = await readShares(r)
    const found = id === undefined ? (shares[key] === undefined ? undefined : ([key, shares[key]] as const)) : Object.entries(shares).find(([, rec]) => rec.id === id)
    if (id !== undefined && found === undefined) throw new BridgeFailure('NOT_FOUND', 'This board is not shared any more.')
    const existing = found?.[1]
    if (existing !== undefined) setSync(existing.id, { state: 'uploading' })
    try {
      const entry = await upload(r, found?.[0] ?? key, existing, content)
      if (existing !== undefined) setSync(existing.id, null)
      return { ...entry, sync: { state: 'ok' } }
    } catch (err) {
      if (existing !== undefined) setSync(existing.id, { state: 'failed', message: err instanceof Error ? err.message : String(err), failedAt: now() })
      throw err
    }
  }

  async function upload(r: string, key: string, existing: ShareRecord | undefined, content: string): Promise<ShareEntry> {
    const size = Buffer.byteLength(content)
    if (size > MAX_SHARE_BYTES)
      throw new BridgeFailure('TOO_LARGE', `This board is ${mb(size)} once its images are packed in, and Cloudflare's free plan accepts at most ${mb(MAX_SHARE_BYTES)} per upload. Use fewer or smaller images, or split the board.`)
    const { password, origin } = await ready()
    const id = existing?.id ?? newShareId()
    const diagram = isDiagram(key)
    const headers: Record<string, string> = { 'content-type': diagram ? 'application/xml' : 'application/json', 'x-board-name': encodeURIComponent(stripName(key)) }
    // 🔒 YAZ-1802 D11: a diagram goes up as its XML, tagged, and the Worker stores the tag as the
    // object's `kind` — the viewer and the download follow it. A drawing sends no tag (missing = drawing).
    if (diagram) headers['x-board-kind'] = 'diagram'
    // The permission travels only when the PUT creates the object: a new share ("can view and
    // download") or a stale one coming back. A plain re-upload never carries it, so it can never
    // undo a permission change — that is PATCH's alone.
    if (existing === undefined || stale.has(id)) headers['x-allow-download'] = (existing?.allowDownload ?? true) ? '1' : '0'
    const res = await worker(origin, 'PUT', `/api/boards/${id}`, password, content, headers, uploadTimeoutMs(size))
    if (res.status === 401) throw new BridgeFailure('PROVIDER_FAILED', `${PASSWORD_REFUSED} Open Settings › Sharing and run Set up sharing again.`)
    if (res.status === 413) throw new BridgeFailure('TOO_LARGE', `Cloudflare refused the upload as too large (${mb(size)}; the limit is ${mb(MAX_SHARE_BYTES)}).`)
    if (!res.ok) throw new BridgeFailure('PROVIDER_FAILED', `The upload failed (HTTP ${res.status}). Try again in a moment.`)
    if (diagram && res.headers.get('x-board-kind') !== 'diagram') {
      // An outdated Worker stored the XML as a drawing, which its viewer cannot draw. A first share
      // is taken back down (nobody has its link yet); a shared one keeps its record, and the next
      // save after Set up sharing puts it right.
      if (existing === undefined) await worker(origin, 'DELETE', `/api/boards/${id}`, password).catch(() => undefined)
      throw new BridgeFailure('PROVIDER_FAILED', WORKER_OUTDATED)
    }
    stale.delete(id)
    const t = now()
    let saved: [string, ShareRecord] | undefined
    await updateShares(r, (shares) => {
      // Found by id: a rename may have moved the record while the upload ran.
      const at = existing === undefined ? key : Object.keys(shares).find((k) => shares[k].id === id)
      if (at === undefined) return false
      shares[at] = { id, allowDownload: shares[at]?.allowDownload ?? true, sharedAt: shares[at]?.sharedAt ?? t, updatedAt: t }
      saved = [at, shares[at]]
      return true
    })
    if (saved === undefined) {
      // Stopped while this upload ran: the stop's DELETE may have landed first, so this PUT put the
      // board back. Take it down again — a stopped link stays dead.
      await worker(origin, 'DELETE', `/api/boards/${id}`, password).catch(() => undefined)
      throw new BridgeFailure('NOT_FOUND', 'This board is not shared any more.')
    }
    ctx.changed()
    return toEntry(r, saved[0], saved[1], origin)
  }

  /** "can view and download" ⇄ "can view only" on the SAME link: one PATCH, no re-upload. */
  async function setPermission(root: string, path: string, allowDownload: boolean): Promise<ShareEntry> {
    const { r, key } = board(root, path)
    const rec = (await readShares(r))[key]
    if (rec === undefined) throw new BridgeFailure('NOT_FOUND', 'This board is not shared.')
    const { password, origin } = await ready()
    const res = await worker(origin, 'PATCH', `/api/boards/${rec.id}`, password, JSON.stringify({ allowDownload }), { 'content-type': 'application/json' })
    if (res.status === 401) throw new BridgeFailure('PROVIDER_FAILED', `${PASSWORD_REFUSED} Open Settings › Sharing and run Set up sharing again.`)
    if (res.status === 404) {
      stale.add(rec.id)
      throw new BridgeFailure('PROVIDER_FAILED', 'The shared copy is gone from Cloudflare, so there is nothing to change. Save the board once to put it back, then try again.')
    }
    if (!res.ok) throw new BridgeFailure('PROVIDER_FAILED', `Changing access failed (HTTP ${res.status}). Try again.`)
    let saved: [string, ShareRecord] = [key, { ...rec, allowDownload }]
    await updateShares(r, (shares) => {
      const at = Object.keys(shares).find((k) => shares[k].id === rec.id)
      if (at === undefined) return false
      shares[at] = { ...shares[at], allowDownload }
      saved = [at, shares[at]]
      return true
    })
    ctx.changed()
    return toEntry(r, saved[0], saved[1], origin)
  }

  async function stop(root: string, path: string): Promise<void> {
    const { r, key } = board(root, path)
    const rec = (await readShares(r))[key]
    if (rec === undefined) return
    const { password, origin } = await ready()
    const res = await worker(origin, 'DELETE', `/api/boards/${rec.id}`, password)
    if (res.status === 401) throw new BridgeFailure('PROVIDER_FAILED', `${PASSWORD_REFUSED} The link is still live: run Set up sharing again, then Stop.`)
    if (!res.ok && res.status !== 404) throw new BridgeFailure('PROVIDER_FAILED', `Stopping failed (HTTP ${res.status}); the link may still work. Try again.`)
    await updateShares(r, (shares) => {
      const at = Object.keys(shares).find((k) => shares[k].id === rec.id)
      if (at !== undefined) delete shares[at]
      return at !== undefined
    })
    stale.delete(rec.id)
    setSync(rec.id, null)
  }

  /** A board (or folder) was renamed or moved inside the app: its shares follow (D10). */
  async function relocate(roots: readonly string[], oldPath: string, newPath: string): Promise<void> {
    for (const root of new Set(roots)) {
      // Records leaving this vault for another open one: [that vault, new path, record].
      const leaving: [string, string, ShareRecord][] = []
      await updateShares(root, (shares) => {
        let changed = false
        for (const [key, rec] of Object.entries(shares)) {
          const fromAbs = absFromKey(root, key)
          if (!isWithin(oldPath, fromAbs)) continue
          const toAbs = newPath + fromAbs.slice(oldPath.length)
          const target = rootOf(roots, toAbs)
          delete shares[key]
          changed = true
          // Out of every open vault: dropped here, and the link keeps its last upload (nothing can update it).
          if (target === root) shares[relKey(root, toAbs)] = rec
          else if (target !== null) leaving.push([target, toAbs, rec])
        }
        return changed
      })
      // Moved into ANOTHER open vault (a cross-vault cut-paste): the record goes with it.
      for (const [target, toAbs, rec] of leaving) {
        await updateShares(target, (shares) => {
          shares[relKey(target, toAbs)] = rec
          return true
        })
      }
    }
    ctx.changed()
  }

  /** A board (or folder) was deleted inside the app: its shares are stopped (D10). */
  async function forget(roots: readonly string[], path: string): Promise<void> {
    for (const root of new Set(roots)) {
      const shares = await readShares(root)
      for (const key of Object.keys(shares)) {
        const abs = absFromKey(root, key)
        if (!isWithin(path, abs)) continue
        try {
          await stop(root, abs)
        } catch (err) {
          // Offline or not set up: keep the record so Settings lists it ("no board at this path") and it can be stopped later.
          console.warn(`[share] could not stop the share of deleted ${abs}: ${String(err)}`)
        }
      }
    }
  }

  return { get, list, publish, setPermission, stop, relocate, forget }
}
