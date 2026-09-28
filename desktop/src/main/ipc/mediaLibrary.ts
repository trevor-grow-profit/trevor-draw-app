import type { AppState, MediaFavoritesRequest, MediaItem, MediaRecentRequest } from '@shared/types'
import { normalizeMediaItem } from '@shared/mediaLibrary'
import { CONTRACT } from '@shared/ipc'
import { BridgeFailure } from '../fs/fsUtils'
import { requireObject, str } from '../fs/validate'
import { resolveLibraryFolder } from '../library/folder'
import { createMediaStore, type MediaStore } from '../library/mediaStore'
import type { Store } from '../store'
import { broadcastAll } from './broadcast'
import { handle } from './envelope'

/**
 * The `media.*` half of `window.yaseenDraw` (🔒 YAZ-1775 D4 / D5, YAZ-1817): the library's media store
 * behind the envelope, plus the ONE push. `media:changed` carries no payload — every window
 * re-lists, whichever vault it is on, because the library is the same file for all of them.
 *
 * The store follows `settings.libraryFolder`: a change re-points it and counts as a change of
 * the library (the lists a window shows are different now), so it broadcasts too.
 */

/** A renderer's item is validated whole (the web app's validator) or refused; it never reaches the file half-read. */
function requireItem(v: unknown): MediaItem {
  const item = normalizeMediaItem(v)
  if (item === null) throw new BridgeFailure('BAD_REQUEST', "'item' must be a complete media item")
  return item
}

function requireFavoritesRequest(v: unknown): MediaFavoritesRequest {
  const r = requireObject(v, 'missing request')
  switch (r.op) {
    case 'list':
      return { op: 'list' }
    case 'add':
      return { op: 'add', item: requireItem(r.item) }
    case 'remove':
      return { op: 'remove', itemKey: str(r.itemKey, 'itemKey') }
    default:
      throw new BridgeFailure('BAD_REQUEST', "'op' must be list, add or remove")
  }
}

function requireRecentRequest(v: unknown): MediaRecentRequest {
  const r = requireObject(v, 'missing request')
  switch (r.op) {
    case 'list':
      return { op: 'list' }
    case 'record':
      return { op: 'record', item: requireItem(r.item) }
    default:
      throw new BridgeFailure('BAD_REQUEST', "'op' must be list or record")
  }
}

/** Returns the store so a test can close its watcher; `main/index.ts` lets the process end take it. */
export function registerMediaLibraryIpc(store: Store, userData: string): MediaStore {
  const folderFor = (state: AppState): string => resolveLibraryFolder(state.settings.libraryFolder, userData)
  let folder = folderFor(store.get())
  const media = createMediaStore(folder)
  media.onChanged(() => broadcastAll(CONTRACT.media.onChanged))
  store.onChange((state) => {
    const next = folderFor(state)
    if (next === folder) return
    folder = next
    media.setFolder(next)
    broadcastAll(CONTRACT.media.onChanged)
  })
  handle(CONTRACT.media.favorites, async (req: unknown) => media.favorites(requireFavoritesRequest(req)))
  handle(CONTRACT.media.recent, async (req: unknown) => media.recent(requireRecentRequest(req)))
  return media
}
