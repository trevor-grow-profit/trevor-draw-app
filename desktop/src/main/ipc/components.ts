/**
 * The `components.*` half of `window.yaseenDraw` (🔒 YAZ-1775 D5, YAZ-1819): the library's component store
 * behind the envelope, plus the ONE push. `components:changed` carries no payload — every window
 * re-lists, whichever vault it is on, because the library is the same folder for all of them.
 *
 * The store follows `settings.libraryFolder` exactly as the media store does: a change re-points
 * it and counts as a change of the library (the components a window can offer are different now),
 * so it broadcasts too.
 *
 * Validation is here rather than in the store for the shape of a request (a sandboxed renderer's
 * arguments are input); the store owns what a NAME, a SLUG and a FRAGMENT have to be, because
 * those are the same rules whether the call came over the bridge or not.
 */
import { shell } from 'electron'
import type { ComponentRenameRequest, ComponentSaveRequest, ComponentSlugRequest } from '@shared/types'
import { CONTRACT } from '@shared/ipc'
import { requireObject, str } from '../fs/validate'
import { followLibraryFolder } from '../library/folder'
import { createComponentStore, type ComponentStore } from '../library/componentStore'
import type { Store } from '../store'
import { broadcastAll } from './broadcast'
import { handle } from './envelope'

/**
 * The SHAPE guards only — "is this field a non-empty string" — because the request crosses IPC
 * from a sandboxed renderer and arrives as `unknown`. What the value MEANS (a real slug, a usable
 * name, a PNG dataURL) is the store's, which is the only layer that can answer it; the messages
 * agree on purpose, so a caller cannot tell which layer refused.
 */
const requireRequest = (v: unknown): Record<string, unknown> => requireObject(v, 'missing request')

function requireSlugRequest(v: unknown): ComponentSlugRequest {
  return { slug: str(requireRequest(v).slug, 'slug') }
}

function requireSaveRequest(v: unknown): ComponentSaveRequest {
  const r = requireRequest(v)
  return { name: str(r.name, 'name'), fragmentJson: str(r.fragmentJson, 'fragmentJson'), previewPng: str(r.previewPng, 'previewPng') }
}

function requireRenameRequest(v: unknown): ComponentRenameRequest {
  const r = requireRequest(v)
  return { slug: str(r.slug, 'slug'), name: str(r.name, 'name') }
}

/** Returns the store so a test can close its watcher; `main/index.ts` lets the process end take it. */
export function registerComponentsIpc(store: Store, userData: string, trash: (p: string) => Promise<void> = (p) => shell.trashItem(p)): ComponentStore {
  const folder = followLibraryFolder(store, userData, (next) => {
    components.setFolder(next)
    broadcastAll(CONTRACT.components.onChanged)
  })
  const components = createComponentStore(folder, { trash })
  components.onChanged(() => broadcastAll(CONTRACT.components.onChanged))
  handle(CONTRACT.components.list, async () => components.list())
  handle(CONTRACT.components.save, async (req: unknown) => components.save(requireSaveRequest(req)))
  handle(CONTRACT.components.read, async (req: unknown) => ({ fragmentJson: await components.read(requireSlugRequest(req)) }))
  handle(CONTRACT.components.rename, async (req: unknown) => components.rename(requireRenameRequest(req)))
  handle(CONTRACT.components.delete, async (req: unknown) => components.delete(requireSlugRequest(req)))
  handle(CONTRACT.components.preview, async (req: unknown) => components.preview(requireSlugRequest(req)))
  return components
}
