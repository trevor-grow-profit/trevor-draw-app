/**
 * ALWAYS-LIVE LINKS (YAZ-1799 🔒 D3). Every successful save of a board that has a `shares.json`
 * entry re-uploads the standalone export to the SAME id, so the link always shows the board as
 * last saved.
 *
 * Coalescing, per board, in this renderer (the window whose autosave wrote the board):
 *  - SETTLE: an upload starts only after 10 s with no further save — a drawing session is many
 *    saves, and each would otherwise be a full re-upload of every image.
 *  - ONE IN FLIGHT: a board never has two uploads at once.
 *  - LATEST WINS: a save that lands mid-upload schedules one more upload after it finishes, which
 *    reads the board from disk again — so the last save is always what ends up behind the link.
 *
 * A failed upload (offline, too large, refused, not set up) keeps the share record; main records the reason
 * (the Share dialog and Settings › Sharing show it) and the next save simply tries again. Nothing
 * here retries on a timer.
 *
 * RENAMES: a board is keyed by path, so an in-app rename (`file:renamed`, via `noteBoardRenamed`)
 * re-keys whatever is pending, queued or in flight — an edit saved seconds before the rename
 * still uploads, under the new path. The upload names its link (`id`), so main lands it on the
 * record even when the rename overtakes it.
 */
import { isWithin } from '@shared/paths'
import { api } from '../api'
import { buildShareContent } from './shareContent'

export const SETTLE_MS = 10_000

interface BoardState {
  root: string
  /** Where the board is now — rewritten by a rename while a timer or an upload holds this state. */
  path: string
  timer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
  again: boolean
}

const boards = new Map<string, BoardState>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Whether `path` has saved edits waiting for the settle period (or a queued re-run). The dialog shows it. */
export function isPending(path: string): boolean {
  const b = boards.get(path)
  return b !== undefined && (b.timer !== null || b.again)
}

/** Subscribe to pending-state changes; returns the unsubscribe. */
export function onLiveShareChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Called by `DrawingEditor` and `DrawioEditor` after every successful save. Cheap: it only (re)arms a timer. */
export function noteBoardSaved(root: string, path: string, settleMs = SETTLE_MS): void {
  const b = boards.get(path) ?? { root, path, timer: null, inFlight: false, again: false }
  b.root = root
  if (b.timer !== null) clearTimeout(b.timer)
  b.timer = setTimeout(() => {
    b.timer = null
    void run(b)
  }, settleMs)
  boards.set(path, b)
  emit()
}

/** An in-app rename or move of `oldPath` (a board, or a folder holding some): pending uploads follow it. */
export function noteBoardRenamed(oldPath: string, newPath: string): void {
  let moved = false
  for (const [path, b] of [...boards]) {
    if (!isWithin(oldPath, path)) continue
    boards.delete(path)
    b.path = newPath + path.slice(oldPath.length)
    boards.set(b.path, b)
    moved = true
  }
  if (moved) emit()
}

async function run(b: BoardState): Promise<void> {
  if (b.inFlight) {
    b.again = true
    emit()
    return
  }
  b.inFlight = true
  b.again = false
  emit()
  const path = b.path
  try {
    // Only boards that are shared; everything else is a no-op.
    const entry = await api.share.get({ root: b.root, path })
    if (entry === null) return
    // No flush: this run was triggered BY a save, so the disk is at least that new. Main checks
    // the size and the setup (TOO_LARGE / NOT_SET_UP are recorded as the board's error) and
    // records every outcome.
    const content = await buildShareContent(b.root, path, { flush: false })
    await api.share.publish({ root: b.root, path, content, id: entry.id })
  } catch {
    // Recorded by main (the dialog and Settings show it); the next save retries. A rename that
    // pulled the board out from under this run is not a failure: run again where it went.
    if (b.path !== path) b.again = true
  } finally {
    b.inFlight = false
    if (b.again) void run(b)
    else if (b.timer === null && boards.get(b.path) === b) boards.delete(b.path)
    emit()
  }
}
/** Test seam: forget every board (timers included). */
export function resetLiveShareForTests(): void {
  for (const b of boards.values()) if (b.timer !== null) clearTimeout(b.timer)
  boards.clear()
}
