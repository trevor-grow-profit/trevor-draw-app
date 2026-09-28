import { isSortOrder, type FolderPatch } from '@shared/types'
import { CH } from '../../channels'
import { BridgeFailure, requireAbsPath } from '../fs/fsUtils'
import { requireObject, strOrNull } from '../fs/validate'
import { isStringArray } from '@shared/guards'
import { isSettings, type Store } from '../store'
import { broadcastAll } from './broadcast'
import { handle } from './envelope'

/** The patch crosses IPC from a sandboxed renderer: only `expanded` / `lastFile` / `sortOrder` / `name`, each type-checked. */
function requireFolderPatch(body: unknown): FolderPatch {
  const raw = requireObject(body, 'patch must be an object')
  const patch: FolderPatch = {}
  if (raw.expanded !== undefined) {
    if (!isStringArray(raw.expanded)) throw new BridgeFailure('BAD_REQUEST', "'expanded' must be a string array")
    patch.expanded = raw.expanded
  }
  if (raw.lastFile !== undefined) patch.lastFile = strOrNull(raw.lastFile, 'lastFile')
  if (raw.sortOrder !== undefined) {
    if (!isSortOrder(raw.sortOrder)) throw new BridgeFailure('BAD_REQUEST', "'sortOrder' must be name, updated or created")
    patch.sortOrder = raw.sortOrder
  }
  // The vault's display name (Docs YAZ-1974 D3): the store trims and caps it.
  if (raw.name !== undefined) patch.name = strOrNull(raw.name, 'name')
  return patch
}

/** The `state.*` half of `window.yaseenDraw` over the main-owned store (GRO-2159). */
export function registerStateIpc(store: Store): void {
  handle(CH.stateGet, async () => store.get())
  handle(CH.stateSetSettings, async (settings: unknown) => {
    if (!isSettings(settings)) throw new BridgeFailure('BAD_REQUEST', "'settings' must be a complete SettingsState")
    store.setSettings(settings)
  })
  handle(CH.stateSetSidebarWidth, async (width: unknown) => {
    if (typeof width !== 'number' || !Number.isFinite(width)) throw new BridgeFailure('BAD_REQUEST', "'width' must be a finite number")
    store.setSidebarWidth(width)
  })
  handle(CH.statePushRecent, async (path: unknown) => {
    store.pushRecent(requireAbsPath(path, 'path'))
  })
  handle(CH.stateRemoveRecent, async (path: unknown) => {
    store.removeRecent(requireAbsPath(path, 'path'))
  })
  handle(CH.stateSetFolder, async (root: unknown, patch: unknown) => {
    store.setFolder(requireAbsPath(root, 'root'), requireFolderPatch(patch))
  })
  // Every live window gets the new state (`state.onChange` in the renderer), whichever window changed it.
  store.onChange((state) => broadcastAll(CH.stateChanged, state))
}
