/**
 * A SCENE FILE DROPPED ON A BOARD ADDS TO IT (GRO: drop merge). The engine's own drop handler
 * (`App.tsx` `handleAppOnDrop` → `loadFileToCanvas`) treats a dropped `.excalidraw` / `.json` as
 * "open this file": it REPLACES every element on the canvas with the file's. That is the web app's
 * rule for a canvas that is a scratchpad; in a vault, the open tab is a document, and dropping a
 * file onto a document you are working on must never wipe it.
 *
 * THE RULE: a single dropped scene file, on a board that already holds elements, is INSERTED — the
 * same door the Components tab uses (`insertElements`, the engine's paste path: fresh ids, fresh
 * seeds, indices synced, frames and bound text kept, the result selected, one undo step) — and its
 * image bytes are handed to the canvas so the next save extracts them into `assets/`
 * (🔒 YAZ-1775 D3, as a component insert does). The file's own appState (background, view) is
 * IGNORED: the board keeps its own. The insert lands at the CENTRE OF THE VIEW, like a paste, not
 * under the cursor: `insertElements` owns placement and takes no position.
 *
 * WHAT IS LEFT TO THE ENGINE, UNCHANGED: a drop on an EMPTY board (the engine opens the file as
 * before — the file's background and view included); images (they insert already); a
 * `.excalidrawlib` (it merges into the library already); several files at once; text and links.
 *
 * ENGINE-BOUND BY DESIGN: every engine value comes in as an argument (`engine.ts`'s lazy rule), so
 * this tests with a stub and names the package nowhere. The surface owns the ONE wiring point — an
 * `onDropCapture` on its own element, which stops the event before the engine's `onDrop` sees it.
 */
import { isRecord } from '@shared/guards'
import type { ExcalidrawImperativeApi, ExcalidrawModule } from './engine'

/** The engine value a merge needs: the same `restoreElements` a component insert runs. */
export type DropEngine = Pick<ExcalidrawModule, 'restoreElements'>
/** The slice of the imperative handle a merge touches. */
export type DropTarget = Pick<ExcalidrawImperativeApi, 'getSceneElements' | 'addFiles' | 'insertElements'>

/** The file extensions the engine would open as a scene, and this module intercepts. */
const SCENE_FILE_EXTENSIONS = ['.excalidraw', '.json'] as const

/** Whether one dropped file is a scene file by name — the engine's own test is by content, later. */
export function isSceneFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return SCENE_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * The one dropped file this module handles, or null when the engine should see the drop instead:
 * no files, several files, or a file of another kind (an image, a `.excalidrawlib`).
 */
export function droppedSceneFile(dataTransfer: Pick<DataTransfer, 'files'> | null): File | null {
  if (dataTransfer === null || dataTransfer.files.length !== 1) return null
  const file = dataTransfer.files[0]
  return isSceneFileName(file.name) ? file : null
}

/**
 * Whether this drop is a MERGE (ours) or an OPEN (the engine's): a board with something on it
 * merges; an empty board opens the file exactly as before.
 */
export function shouldMergeDrop(sceneElements: readonly unknown[]): boolean {
  return sceneElements.some((element) => !(isRecord(element) && element.isDeleted === true))
}

/** What a scene file carries once parsed: its live elements and the image bytes it embeds. */
interface DroppedScene {
  elements: readonly unknown[]
  files: Record<string, unknown>
}

/**
 * The file's JSON as a scene. Anything with an `elements` array counts — a board saved by this app,
 * an excalidraw.com export, a component fragment — so a `.json` that is not a scene is refused
 * with a sentence the user can read. Deleted elements never travel.
 */
export function parseDroppedScene(json: string): DroppedScene {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('the file is not valid JSON')
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.elements)) throw new Error('the file is not an Excalidraw drawing')
  return {
    elements: parsed.elements.filter((element) => !(isRecord(element) && element.isDeleted === true)),
    files: isRecord(parsed.files) ? parsed.files : {},
  }
}

/** The embedded files as `addFiles` wants them: only the ones a live image names, each carrying its id. */
function fileEntries(files: Record<string, unknown>, elements: readonly unknown[]): Parameters<DropTarget['addFiles']>[0] {
  const referenced = new Set<string>()
  for (const element of elements) if (isRecord(element) && element.type === 'image' && typeof element.fileId === 'string') referenced.add(element.fileId)
  const created = Date.now()
  return Object.entries(files)
    .filter(([id, entry]) => referenced.has(id) && isRecord(entry) && typeof entry.dataURL === 'string')
    .map(([id, entry]) => ({ ...(entry as Record<string, unknown>), id, created })) as unknown as Parameters<DropTarget['addFiles']>[0]
}

/**
 * Add a dropped scene to the board. Restored with `repairBindings` (a file from elsewhere may name
 * an arrow's target it no longer carries), bytes first, then the elements through the engine's own
 * paste door. Answers the elements handed in — an empty file adds nothing and is not an error.
 */
export function mergeDroppedScene(engine: DropEngine, api: DropTarget, json: string): readonly unknown[] {
  const scene = parseDroppedScene(json)
  if (scene.elements.length === 0) return []
  const restored = (engine.restoreElements(scene.elements as never, null, { repairBindings: true }) as unknown as readonly unknown[]).filter(
    (element) => !(isRecord(element) && element.isDeleted === true),
  )
  if (restored.length === 0) return []
  const entries = fileEntries(scene.files, restored)
  if (entries.length > 0) api.addFiles(entries)
  api.insertElements(restored as never)
  return restored
}
