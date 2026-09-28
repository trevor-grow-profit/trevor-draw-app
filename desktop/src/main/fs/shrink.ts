/**
 * "MOVE PICTURES OUT OF BOARDS" (YAZ-1801 D5) — Settings › Storage's one action: every legacy
 * board in the vault that still embeds its pictures as base64 is rewritten LEAN, the way its next
 * save would have written it, without waiting for someone to open and edit each one.
 *
 * It is the save's own extraction (`liftEmbedded` + `landAssets` in `drawing.ts`), not a second
 * set of rules: referenced pictures land in `assets/` first (`wx`, EEXIST ok — two boards sharing
 * one picture store it once), THEN the lean scene replaces the board atomically, so a crash can
 * leave an unreferenced asset (the orphan sweep's business) but never a board naming bytes that
 * are not there. Unreferenced embedded entries are dropped, as a save drops them.
 *
 * WHAT IT DOES NOT DO — the difference from a save, and the reason this is not `drawing:save`:
 * it does not STAMP. The `yaseendraw` block (🔒 YAZ-1834) rides through verbatim — same keys,
 * same values, same place — because moving bytes between files is not an edit, and "Last updated"
 * jumping on forty boards the user never touched would be a lie in the sidebar's sort. The text is
 * re-serialized the way every board main writes (2-space, trailing newline).
 *
 * NEVER THROWS PER BOARD. A board it cannot read, parse, or write — or one in `skip` (the renderer
 * passes boards with unsaved edits in a tab: rewriting under a dirty buffer is exactly the
 * conflict bar's case), or one that changed on disk while it was being read — counts as skipped
 * and the walk goes on. Boards with nothing embedded are neither shrunk nor skipped.
 *
 * Clean open tabs need nothing from here: the rewrite is an ordinary external change, and the
 * editor's watcher rule reloads a clean tab silently (`DrawingEditor` — echo / reload / conflict).
 */
import { stat } from 'node:fs/promises'
import { MAX_DRAWING_BYTES, type ShrinkResult } from '@shared/types'
import { isDrawing } from '@shared/fileKind'
import { serializeBoard } from '@shared/drawingAssets'
import { readBoundedRegularFile } from './boundedRead'
import { landAssets, liftEmbedded } from './drawing'
import { atomicWrite, vaultFiles } from './fsUtils'

/** Every `.excalidraw` in the vault outside the top-level store, in a stable order. */
async function boardsUnder(root: string): Promise<string[]> {
  const out: string[] = []
  for await (const f of vaultFiles(root)) if (!f.inAssets && isDrawing(f.name)) out.push(f.full)
  return out.sort()
}

/** Whether a parsed scene still carries any `files` entry at all — the only boards there is work on. */
function hasEmbedded(scene: Record<string, unknown>): boolean {
  const files = scene.files
  return typeof files === 'object' && files !== null && Object.keys(files).length > 0
}

type Outcome = { kind: 'none' } | { kind: 'skipped' } | { kind: 'shrunk'; bytesMoved: number }

async function shrinkOne(root: string, file: string, skip: ReadonlySet<string>): Promise<Outcome> {
  let snapshot: Awaited<ReturnType<typeof readBoundedRegularFile>>
  try {
    snapshot = await readBoundedRegularFile(file, MAX_DRAWING_BYTES, 'too large')
  } catch {
    return { kind: 'skipped' }
  }
  const json = snapshot.data.toString('utf8')
  let scene: unknown
  try {
    scene = JSON.parse(json)
  } catch {
    return { kind: 'skipped' }
  }
  if (typeof scene !== 'object' || scene === null || Array.isArray(scene)) return { kind: 'skipped' }
  const record = scene as Record<string, unknown>
  if (!hasEmbedded(record)) return { kind: 'none' }
  if (!Array.isArray(record.elements) || skip.has(file)) return { kind: 'skipped' }
  try {
    const { lean: leanScene, lifted } = liftEmbedded(record, record.elements)
    const lean = serializeBoard(leanScene)
    await landAssets(root, lifted)
    // The cheap guard against a writer that landed while we were decoding: the file must still be
    // the one we read. A tab that saved in between wins, and this board waits for the next click.
    const now = await stat(file)
    if (now.mtimeMs !== snapshot.mtime) return { kind: 'skipped' }
    await atomicWrite(file, lean)
    return { kind: 'shrunk', bytesMoved: Math.max(0, snapshot.size - Buffer.byteLength(lean, 'utf8')) }
  } catch {
    return { kind: 'skipped' }
  }
}

/** One pass over the vault; boards one at a time, so a 110 MB board is the most held in memory. */
export async function shrinkVault(root: string, opts: { skip?: readonly string[] } = {}): Promise<ShrinkResult> {
  const skip = new Set(opts.skip ?? [])
  const result: ShrinkResult = { shrunk: 0, skipped: 0, bytesMoved: 0 }
  for (const file of await boardsUnder(root)) {
    const outcome = await shrinkOne(root, file, skip)
    if (outcome.kind === 'skipped') result.skipped += 1
    else if (outcome.kind === 'shrunk') {
      result.shrunk += 1
      result.bytesMoved += outcome.bytesMoved
    }
  }
  return result
}
