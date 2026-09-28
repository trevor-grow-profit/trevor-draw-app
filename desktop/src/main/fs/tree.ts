import type { TreeResponse } from '@shared/types'
import { ASSETS_DIR } from '@shared/drawingAssets'
import { buildTree, fsCall, requireAbsPath, requireDir } from './fsUtils'

/**
 * `window.yaseenDraw.tree(root)`: recursive vault tree of `root` (see `buildTree`).
 *
 * The TOP-LEVEL `assets/` folder is hidden (🔒 YAZ-1775 D3): it is the image store, written and read by
 * the app alone, and its contents are content-hash names no one would ever click. Only the one
 * at the root — a folder the user made and called `assets` inside a subfolder is theirs, and
 * hiding it by name anywhere would be the app deciding what the user may see in their own vault.
 * Hidden from the TREE, not from disk: the sweep and the loader address it directly.
 */
export async function tree(root: string): Promise<TreeResponse> {
  const dir = requireAbsPath(root, 'root')
  const flight = flights.get(dir)
  if (flight === undefined) return walkOnce(dir)
  const next = () => walkOnce(dir)
  return (flight.next ??= flight.walk.then(next, next))
}

/**
 * ONE walk per root at a time (YAZ-2073 5E, 🔒 D10). A caller arriving mid-walk joins the single
 * trailing walk that starts when the current one ends — never the running one, whose snapshot may
 * predate the change behind the call — so every answer still post-dates its request (🔒 YAZ-1835 D4),
 * but a storm of N watcher events costs two walks instead of N concurrent ones.
 */
interface Flight {
  walk: Promise<TreeResponse>
  /** The one walk queued behind `walk`, shared by every caller that arrived during it. */
  next?: Promise<TreeResponse>
}
const flights = new Map<string, Flight>()

function walkOnce(dir: string): Promise<TreeResponse> {
  const flight: Flight = { walk: walk(dir) }
  flights.set(dir, flight)
  const done = () => {
    if (flights.get(dir) === flight && flight.next === undefined) flights.delete(dir)
  }
  void flight.walk.then(done, done)
  return flight.walk
}

async function walk(dir: string): Promise<TreeResponse> {
  await requireDir(dir)
  const nodes = await fsCall(dir, () => buildTree(dir))
  return { root: dir, tree: nodes.filter((n) => !(n.type === 'dir' && n.name === ASSETS_DIR)), generatedAt: Date.now() }
}
