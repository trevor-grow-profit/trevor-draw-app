/**
 * THE IMAGE STUDIO'S THREE DOORS (🔒 YAZ-1775 D4, YAZ-1818): `media:search`, `media:preview`,
 * `media:import`. The guard layer only — every decision is `main/media/`'s, every request is
 * validated whole here first, because a sandboxed renderer's arguments are input.
 *
 * WHY THE SECRETS INSTANCE IS PASSED IN: `registerSecretsIpc` owns `userData/secrets.json` and
 * returns the one object that can `read` it. Threading it here is what lets the providers build a
 * Pixabay request without the key ever existing outside main (🔒 YAZ-1775 D4). A second `createSecrets`
 * would be a second writer to the same file.
 *
 * THE CACHE IS SWEPT ONCE, AT REGISTRATION, DETACHED. `<userData>/media-cache/` is bounded by age
 * and nothing else, so the moment the app starts is exactly when yesterday's entries should go —
 * and the first search must not wait for a `readdir` of it.
 */
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { isMediaBytesProvider, isMediaSearchSource, PIXABAY_SECRET, type MediaBytesRequest, type MediaSearchRequest } from '@shared/types'
import { CONTRACT } from '@shared/ipc'
import { BridgeFailure } from '../fs/fsUtils'
import { requireRequest, str, strOrNull } from '../fs/validate'
import { createMediaCache } from '../media/cache'
import { MEDIA_CACHE_DIR } from '../media/cachePolicy'
import { createMediaProviders } from '../media/providers'
import type { Secrets } from '../secrets'
import { handle } from './envelope'

function requireSearchRequest(v: unknown): MediaSearchRequest {
  const r = requireRequest(v)
  if (typeof r.q !== 'string') throw new BridgeFailure('BAD_REQUEST', "'q' must be a string")
  if (!isMediaSearchSource(r.source)) throw new BridgeFailure('BAD_REQUEST', "'source' must be all, iconify or pixabay")
  return { q: r.q, source: r.source, cursor: r.cursor === undefined ? null : strOrNull(r.cursor, 'cursor') }
}

function requireBytesRequest(v: unknown): MediaBytesRequest {
  const r = requireRequest(v)
  // `shape` is deliberately not one of these: a shape is drawn by the renderer from its own
  // catalog and has no bytes to fetch (🔒 YAZ-1775 D4).
  if (!isMediaBytesProvider(r.provider)) throw new BridgeFailure('BAD_REQUEST', "'provider' must be pixabay or iconify")
  return { provider: r.provider, id: str(r.id, 'id') }
}

/** The cache folder this registration owns — the one fact a test needs back from it. */
export function registerMediaStudioIpc(userData: string, secrets: Secrets, fetchImpl: typeof globalThis.fetch = globalThis.fetch): string {
  const folder = join(userData, MEDIA_CACHE_DIR)
  const cache = createMediaCache(folder)
  const providers = createMediaProviders({ fetch: fetchImpl, readPixabayKey: () => secrets.read(PIXABAY_SECRET), cache })

  // Detached: the folder has to exist before the first write, and yesterday's entries have to go,
  // but neither is something a renderer should ever wait behind.
  void mkdir(folder, { recursive: true })
    .then(() => cache.sweep())
    .then(
      (swept) => {
        if (swept > 0) console.log(`[media-cache] swept ${swept} expired entr${swept === 1 ? 'y' : 'ies'}`)
      },
      (err: unknown) => console.warn('[media-cache] could not prepare', folder, err),
    )

  handle(CONTRACT.media.search, async (req: unknown) => providers.search(requireSearchRequest(req)))
  handle(CONTRACT.media.preview, async (req: unknown) => providers.preview(requireBytesRequest(req)))
  handle(CONTRACT.media.import, async (req: unknown) => providers.import(requireBytesRequest(req)))

  return folder
}
