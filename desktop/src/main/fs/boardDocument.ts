/**
 * What a board's two doors share (YAZ-2073 🔒 D16), whichever kind it is: `drawing.ts` (a
 * `.excalidraw`) and `diagram.ts` (a `.drawio`) resolve a request's board and guard and stamp a
 * save through here, and keep only what their format needs.
 */
import path from 'node:path'
import { MAX_DIAGRAM_BYTES, MAX_DRAWING_BYTES } from '@shared/types'
import type { BoardMetaBlock } from '@shared/drawingAssets'
import { isDiagram, isDrawing } from '@shared/fileKind'
import { isWithin } from '@shared/paths'
import { readBoardHead } from './boardHead'
import { BridgeFailure, fsCall } from './fsUtils'
import { requireAbsPath, requireObject } from './validate'

type BoardKind = 'drawing' | 'diagram'

/** Each kind's extension test, the words its failures use, and its read/write ceiling. */
export const BOARDS = {
  drawing: { is: isDrawing, noun: 'Excalidraw drawing', refused: 'only .excalidraw files open as drawings', max: MAX_DRAWING_BYTES, tooLarge: `drawing exceeds ${MAX_DRAWING_BYTES} bytes` },
  diagram: { is: isDiagram, noun: 'draw.io diagram', refused: 'only .drawio files open as diagrams', max: MAX_DIAGRAM_BYTES, tooLarge: `diagram exceeds ${MAX_DIAGRAM_BYTES} bytes` },
} as const

/** A board path — vault-relative or absolute — resolved INSIDE `dir`; any other kind is refused. */
export function resolveBoard(dir: string, rel: unknown, kind: BoardKind): string {
  if (typeof rel !== 'string' || rel.trim() === '' || rel.includes('\0')) throw new BridgeFailure('BAD_REQUEST', "missing 'path'")
  const file = path.resolve(dir, rel)
  if (!isWithin(dir, file, true)) throw new BridgeFailure('BAD_REQUEST', 'path escapes the vault root', { path: rel })
  if (!BOARDS[kind].is(file)) throw new BridgeFailure('UNSUPPORTED_EXTENSION', BOARDS[kind].refused, { path: file })
  return file
}

/** The request's `{ root, path }` pair, validated once for both of a kind's doors. */
export function boardTarget(raw: unknown, kind: BoardKind): { dir: string; file: string; body: Record<string, unknown> } {
  const body = requireObject(raw)
  const dir = requireAbsPath(body.root, 'root')
  return { dir, file: resolveBoard(dir, body.path, kind), body }
}

/**
 * The text a save writes, stamped and guarded. The file as it is now — its dates and mtime in one
 * open (🔒 YAZ-1834 D3, 🔒 YAZ-1802 D7) — serves both the stamp and the conflict guard: a dateless
 * board is as old as its file, a brand-new one is born now, and the bytes measured against the
 * ceiling are the bytes that will be written. A file that is GONE is not a conflict: the tab's own
 * copy is the only one left, and refusing would strand it. Only a file that is there and DIFFERENT
 * blocks the write.
 */
export async function guardedStamp(file: string, kind: BoardKind, expectedMtime: number | undefined, stamp: (at: { createdAt: number; updatedAt: number }, prior: BoardMetaBlock | null) => string): Promise<string> {
  const prior = await fsCall(file, () => readBoardHead(file))
  const now = Date.now()
  const stamped = stamp({ createdAt: prior?.mtime ?? now, updatedAt: now }, prior?.block ?? null)
  if (Buffer.byteLength(stamped, 'utf8') > BOARDS[kind].max) throw new BridgeFailure('TOO_LARGE', BOARDS[kind].tooLarge, { path: file })
  if (expectedMtime !== undefined && prior !== null && prior.mtime !== expectedMtime) {
    throw new BridgeFailure('CONFLICT', `${BOARDS[kind].noun} changed on disk since last read`, { path: file, mtime: prior.mtime })
  }
  return stamped
}
