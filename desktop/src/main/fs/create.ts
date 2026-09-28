import { mkdir, stat, writeFile } from 'node:fs/promises'
import type { CreateDirResponse, CreateFileRequest, CreateFileResponse } from '@shared/types'
import { isDiagram, isDrawing } from '@shared/fileKind'
import { stampBoardMeta } from '@shared/drawingAssets'
import { diagramDocumentError, diagramRoot, stampDiagramMeta } from '@shared/diagramFile'
import { BridgeFailure, fsCall, requireAbsPath } from './fsUtils'
import { requireObject } from './validate'

/**
 * Creation calls for the sidebar's "New folder" / "New drawing" (GRO-2022). Existence races
 * resolve at the fs layer: mkdir and `wx` writes throw EEXIST, which `toBridgeFailure` maps to
 * ALREADY_EXISTS — nothing is ever overwritten.
 */
export async function createDir(path: string): Promise<CreateDirResponse> {
  const p = requireAbsPath(path, 'path')
  await fsCall(p, () => mkdir(p))
  return { path: p }
}

/**
 * "New drawing" is born with its scene inside it, in ONE atomic `wx` write (Bible B, GRO-2202) —
 * no create-then-write race, and never a zero-byte `.excalidraw`, which 🔒 YAZ-1810 calls the
 * corrupt case rather than a new board. It is born STAMPED too (🔒 YAZ-1834 D3): its
 * `yaseendraw` block — `createdAt` and `updatedAt`, both "now" — goes first, so no board main
 * creates ever exists without its dates. Content that is not a JSON object is refused
 * `BAD_REQUEST` before the disk is touched.
 *
 * "New draw.io diagram" (🔒 YAZ-1802 D13) is the same birth for a `.drawio`: its own content
 * check (an `<mxfile>` document, whole — never a zero-byte file) and its own stamp, the two
 * `yaseendraw-*` attributes on the root (D7). Every other extension is still refused.
 */
export async function createFile(req: CreateFileRequest): Promise<CreateFileResponse> {
  // Crosses IPC from a sandboxed renderer: shape-checked like a request body.
  const { path, content } = requireObject(req)
  const p = requireAbsPath(path, 'path')
  if (!isDrawing(p) && !isDiagram(p)) throw new BridgeFailure('UNSUPPORTED_EXTENSION', 'only .excalidraw and .drawio files can be created', { path: p })
  if (typeof content !== 'string') throw new BridgeFailure('BAD_REQUEST', "'content' must be a string", { path: p })
  const now = Date.now()
  let body: string
  if (isDiagram(p)) {
    if (diagramRoot(content) !== 'mxfile' || diagramDocumentError(content) !== null) throw new BridgeFailure('BAD_REQUEST', "'content' must be a draw.io <mxfile> diagram", { path: p })
    body = stampDiagramMeta(content, { createdAt: now, updatedAt: now })
  } else {
    try {
      body = stampBoardMeta(content, { createdAt: now, updatedAt: now })
    } catch {
      throw new BridgeFailure('BAD_REQUEST', "'content' must be an Excalidraw scene", { path: p })
    }
  }
  return fsCall(p, async () => {
    await writeFile(p, body, { flag: 'wx' })
    const st = await stat(p)
    return { path: p, mtime: st.mtimeMs, size: st.size }
  })
}
