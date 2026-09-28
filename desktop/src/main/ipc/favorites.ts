import type { AppState } from '@shared/types'
import { CONTRACT } from '@shared/ipc'
import { isStringArray } from '@shared/guards'
import { getFavorites, setFavorites, subscribeFavorites } from '../favorites'
import { BridgeFailure, requireAbsPath } from '../fs/fsUtils'
import { openRoots, type Store } from '../store'
import { broadcastAll } from './broadcast'
import { handle } from './envelope'

/** Main's own favorites subscription per open-vault root; dropped when the last window on that root goes. */
const subs = new Map<string, () => void>()

/** Every live window gets the change; renderers filter by their own root and re-read (`broadcastAll`'s posture). */
const broadcast = (change: { root: string }): void => broadcastAll(CONTRACT.favorites.onChanged, change)

/** One `subscribeFavorites` per open-vault root, no more. */
function syncSubscriptions(state: AppState): void {
  const roots = new Set(openRoots(state))
  for (const [root, off] of subs) {
    if (!roots.has(root)) {
      off()
      subs.delete(root)
    }
  }
  for (const root of roots) {
    if (!subs.has(root)) subs.set(root, subscribeFavorites(root, broadcast))
  }
}

/** The `favorites.*` half of `window.yaseenDraw` (YAZ-1766 6A). */
export function registerFavoritesIpc(store: Store): void {
  handle(CONTRACT.favorites.get, async (root: unknown) => getFavorites(requireAbsPath(root, 'root')))
  handle(CONTRACT.favorites.set, async (root: unknown, paths: unknown) => {
    const r = requireAbsPath(root, 'root')
    if (!isStringArray(paths)) throw new BridgeFailure('BAD_REQUEST', "'paths' must be a string array")
    await setFavorites(r, paths)
  })
  store.onChange(syncSubscriptions)
  syncSubscriptions(store.get())
}
