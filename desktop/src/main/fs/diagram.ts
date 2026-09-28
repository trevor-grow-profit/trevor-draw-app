/**
 * `diagram:load` / `diagram:save` (🔒 YAZ-1802 D6) — `drawing.ts`'s twin for a `.drawio`: the only
 * way a diagram opened as a document is read and written. Both doors refuse a file that fails the
 * outline check, so the editor never mounts on it and never autosaves over it. The save follows
 * `drawing:save`'s rules and stamps the D7 dates. Long form: docs/CONTRACTS.md › draw.io diagrams.
 */
import path from 'node:path'
import type { DiagramLoadRequest, DiagramLoadResponse, DiagramSaveRequest, DiagramSaveResponse } from '@shared/types'
import { MAX_DIAGRAM_BYTES } from '@shared/types'
import { isDiagram } from '@shared/fileKind'
import { diagramDocumentError, stampDiagramMeta } from '@shared/diagramFile'
import { isWithin } from '@shared/paths'
import { readBoardHead } from './boardHead'
import { readBoundedRegularFile } from './boundedRead'
import { atomicWrite, BridgeFailure, fsCall, requireAbsPath, requireDir } from './fsUtils'
import { requireObject } from './validate'

const TOO_LARGE = `diagram exceeds ${MAX_DIAGRAM_BYTES} bytes`

/** A `.drawio` path — vault-relative or absolute — resolved INSIDE `dir`; any other kind is refused. */
export function resolveDiagram(dir: string, rel: unknown): string {
  if (typeof rel !== 'string' || rel.trim() === '' || rel.includes('\0')) throw new BridgeFailure('BAD_REQUEST', "missing 'path'")
  const file = path.resolve(dir, rel)
  if (!isWithin(dir, file, true)) throw new BridgeFailure('BAD_REQUEST', 'path escapes the vault root', { path: rel })
  if (!isDiagram(file)) throw new BridgeFailure('UNSUPPORTED_EXTENSION', 'only .drawio files open as diagrams', { path: file })
  return file
}

/** The request's `{ root, path }` pair, validated once for both doors. */
function target(raw: unknown): { dir: string; file: string; body: Record<string, unknown> } {
  const body = requireObject(raw)
  const dir = requireAbsPath(body.root, 'root')
  return { dir, file: resolveDiagram(dir, body.path), body }
}

export async function loadDiagram(req: DiagramLoadRequest): Promise<DiagramLoadResponse> {
  const { dir, file } = target(req)
  await requireDir(dir)
  const snapshot = await readBoundedRegularFile(file, MAX_DIAGRAM_BYTES, TOO_LARGE)
  const xml = snapshot.data.toString('utf8')
  const problem = diagramDocumentError(xml)
  if (problem !== null) throw new BridgeFailure('IO_ERROR', problem, { path: file })
  return { path: file, xml, mtime: snapshot.mtime, size: snapshot.size }
}

export async function saveDiagram(req: DiagramSaveRequest): Promise<DiagramSaveResponse> {
  const { dir, file, body } = target(req)
  const { xml, expectedMtime } = body
  if (typeof xml !== 'string') throw new BridgeFailure('BAD_REQUEST', "'xml' must be a string", { path: file })
  if (expectedMtime !== undefined && typeof expectedMtime !== 'number') throw new BridgeFailure('BAD_REQUEST', "'expectedMtime' must be a number", { path: file })
  // Every check before any write: a diagram the editor could not have produced is refused whole.
  const problem = diagramDocumentError(xml)
  if (problem !== null) throw new BridgeFailure('BAD_REQUEST', `'xml' is not a draw.io diagram: ${problem}`, { path: file })
  await requireDir(dir)
  // The file as it is now: its dates and mtime in one open, serving both the guard and the stamp.
  const prior = await fsCall(file, () => readBoardHead(file))
  const now = Date.now()
  const bornAt = prior?.mtime ?? now
  const stamped = stampDiagramMeta(xml, { createdAt: bornAt, updatedAt: now }, prior?.block ?? null)
  if (Buffer.byteLength(stamped, 'utf8') > MAX_DIAGRAM_BYTES) throw new BridgeFailure('TOO_LARGE', TOO_LARGE, { path: file })
  if (expectedMtime !== undefined && prior !== null && prior.mtime !== expectedMtime) {
    // A file that is GONE is not a conflict (the `drawing:save` rule): the tab's copy is the only one left.
    throw new BridgeFailure('CONFLICT', 'draw.io diagram changed on disk since last read', { path: file, mtime: prior.mtime })
  }
  const { mtime, size } = await fsCall(file, () => atomicWrite(file, stamped))
  return { path: file, mtime, size }
}
