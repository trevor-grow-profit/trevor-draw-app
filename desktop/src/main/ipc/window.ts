import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { isSidebarLens, type SidebarLens, type WindowEntry, type WindowIdentity } from '@shared/types'
import { CONTRACT, SPECIAL } from '@shared/ipc'
import { BridgeFailure } from '../fs/fsUtils'
import { absPaths, optBool, requireAbsPath, requireObject, strOrNull } from '../fs/validate'
import { normalizeTabs, type Store } from '../store'
import type { WindowManagerIpc } from '../windows'
import { handle, handleWithEvent } from './envelope'

/** `root` / `file` in the patch: absent (untouched), null, or an absolute path. */
function optionalPath(raw: Record<string, unknown>, key: 'root' | 'file'): string | null | undefined {
  const v = raw[key]
  return v === undefined || v === null ? v : requireAbsPath(strOrNull(v, key), key)
}

/** `tabs` (GRO-2232), `focusDirs` / `focusFavorites` (YAZ-1628, YAZ-1766) in the patch: absent (untouched), or absolute paths only — one bad element rejects the whole call. */
function optionalPaths(raw: Record<string, unknown>, key: 'tabs' | 'focusDirs' | 'focusFavorites'): string[] | undefined {
  return raw[key] === undefined ? undefined : absPaths(raw[key], key)
}

/** `sidebarLens` (YAZ-1628; Favorites added by YAZ-1766): absent (untouched), or one of the two lenses. */
function optionalSidebarLens(raw: Record<string, unknown>): SidebarLens | undefined {
  const v = raw.sidebarLens
  if (v === undefined) return undefined
  if (!isSidebarLens(v)) throw new BridgeFailure('BAD_REQUEST', "'sidebarLens' must be 'files' or 'favorites'")
  return v
}

/**
 * The `window.*` half of `window.yaseenDraw`. The caller is resolved through the window lookup
 * (`webContents.id` → window id) and answered from `AppState.windows`; `app:flushed` is the
 * renderer's half of the close/quit flush handshake.
 */
export function registerWindowIpc(store: Store, windows: WindowManagerIpc): void {
  const entryFor = (e: IpcMainInvokeEvent): WindowEntry => {
    const id = windows.idFor(e.sender)
    if (id === undefined) throw new BridgeFailure('BAD_REQUEST', 'sender is not a registered window')
    const entry = store.get().windows.find((w) => w.id === id)
    if (entry === undefined) throw new BridgeFailure('NOT_FOUND', `window ${id} is not in the app state`)
    return entry
  }

  handleWithEvent(CONTRACT.window.identity, async (e): Promise<WindowIdentity> => {
    const { id, root, file, tabs, sidebarCollapsed, sidebarLens, focusDirs, focusFavorites } = entryFor(e)
    return { id, root, file, tabs: [...tabs], sidebarCollapsed, sidebarLens, focusDirs: [...focusDirs], focusFavorites: [...focusFavorites] }
  })

  handleWithEvent(CONTRACT.window.setIdentity, async (e, raw: unknown) => {
    const patch = requireObject(raw, 'patch must be an object')
    const root = optionalPath(patch, 'root')
    const file = optionalPath(patch, 'file')
    const tabs = optionalPaths(patch, 'tabs')
    const sidebarCollapsed = optBool(patch.sidebarCollapsed, 'sidebarCollapsed')
    const sidebarLens = optionalSidebarLens(patch)
    const focusDirs = optionalPaths(patch, 'focusDirs')
    const focusFavorites = optionalPaths(patch, 'focusFavorites')
    const entry = entryFor(e)
    // The tabs invariant holds on the entry AS WRITTEN (GRO-2232): the loader's repair rule,
    // applied to whichever of `file` / `tabs` the patch left untouched.
    const nextFile = file !== undefined ? file : entry.file
    const nextTabs = normalizeTabs(tabs ?? entry.tabs, nextFile)
    store.upsertWindow({
      ...entry,
      ...(root !== undefined ? { root } : {}),
      ...(sidebarCollapsed !== undefined ? { sidebarCollapsed } : {}),
      ...(sidebarLens !== undefined ? { sidebarLens } : {}),
      ...(focusDirs !== undefined ? { focusDirs } : {}),
      ...(focusFavorites !== undefined ? { focusFavorites } : {}),
      file: nextFile,
      tabs: nextTabs,
    })
  })

  // `window:close-self` (GRO-2232): the REAL close on the caller's own window, so the
  // close/flush handshake in windows.ts runs — never a destroy. Resolved via the window lookup
  // only (no state lookup): a window mid-close can still ask.
  handleWithEvent(CONTRACT.window.closeSelf, async (e) => {
    const id = windows.idFor(e.sender)
    if (id === undefined) throw new BridgeFailure('BAD_REQUEST', 'sender is not a registered window')
    windows.closeWindow(id)
  })

  handle(CONTRACT.window.open, async (raw: unknown) => {
    const opts = requireObject(raw, 'options must be an object')
    windows.openWindow({ root: optionalPath(opts, 'root') ?? null, file: optionalPath(opts, 'file') ?? null })
  })

  // `window:open-recent` (YAZ-1767 D1): the vault switcher's door — an absolute path in, and the
  // manager's verdict out: true = the vault is in front (its windows raised, D9, or a new one
  // opened; MRU bumped), false = the folder is gone and was pruned from the MRU instead. Any
  // window may ask; the caller is not consulted.
  handle(CONTRACT.window.openRecent, async (path: unknown): Promise<boolean> => windows.openRecentBeside(requireAbsPath(path, 'path')))

  // The renderer's ack in the flush handshake (fire-and-forget send, so no envelope).
  ipcMain.on(SPECIAL.appFlushed, (e) => windows.handleFlushed(e.sender))
}
