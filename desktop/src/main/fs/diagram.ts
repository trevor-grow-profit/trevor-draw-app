/**
 * `diagram:load` / `diagram:save` (🔒 YAZ-1802 D6) — `drawing.ts`'s twin for a `.drawio`: the only
 * way a diagram opened as a document is read and written. Both doors refuse a file that fails the
 * outline check, so the editor never mounts on it and never autosaves over it. The save follows
 * `drawing:save`'s rules and stamps the D7 dates. Long form: docs/CONTRACTS.md › draw.io diagrams.
 */
import type { DiagramLoadResponse, DiagramSaveResponse } from '@shared/types'
import { diagramDocumentError, stampDiagramMeta } from '@shared/diagramFile'
import { BOARDS, boardTarget, guardedStamp } from './boardDocument'
import { readBoundedRegularFile } from './boundedRead'
import { atomicWrite, BridgeFailure, fsCall, requireDir } from './fsUtils'

export async function loadDiagram(req: unknown): Promise<DiagramLoadResponse> {
  const { dir, file } = boardTarget(req, 'diagram')
  await requireDir(dir)
  const snapshot = await readBoundedRegularFile(file, BOARDS.diagram.max, BOARDS.diagram.tooLarge)
  const xml = snapshot.data.toString('utf8')
  const problem = diagramDocumentError(xml)
  if (problem !== null) throw new BridgeFailure('IO_ERROR', problem, { path: file })
  return { path: file, xml, mtime: snapshot.mtime, size: snapshot.size }
}

export async function saveDiagram(req: unknown): Promise<DiagramSaveResponse> {
  const { dir, file, body } = boardTarget(req, 'diagram')
  const { xml, expectedMtime } = body
  if (typeof xml !== 'string') throw new BridgeFailure('BAD_REQUEST', "'xml' must be a string", { path: file })
  if (expectedMtime !== undefined && typeof expectedMtime !== 'number') throw new BridgeFailure('BAD_REQUEST', "'expectedMtime' must be a number", { path: file })
  // Every check before any write: a diagram the editor could not have produced is refused whole.
  const problem = diagramDocumentError(xml)
  if (problem !== null) throw new BridgeFailure('BAD_REQUEST', `'xml' is not a draw.io diagram: ${problem}`, { path: file })
  await requireDir(dir)
  const stamped = await guardedStamp(file, 'diagram', expectedMtime, (at, prior) => stampDiagramMeta(xml, at, prior))
  const { mtime, size } = await fsCall(file, () => atomicWrite(file, stamped))
  return { path: file, mtime, size }
}
