import path from 'node:path'
import { MAX_DIAGRAM_BYTES, MAX_DRAWING_BYTES, type BoardVersion, type BoardVersionScene } from '@shared/types'
import { diagramDocumentError } from '@shared/diagramFile'
import { stripEmbeddedScene } from '@shared/drawingAssets'
import { isDiagram } from '@shared/fileKind'
import { resolveBoard } from '../fs/boardDocument'
import { saveDiagram } from '../fs/diagram'
import { parseScene, resolveFiles } from '../fs/drawing'
import { atomicWrite, BridgeFailure } from '../fs/fsUtils'
import { requireAbsPath } from '../fs/validate'
import { git, resolveGit } from './exec'
import { BEFORE_MERGE_REF } from './resolve'

/**
 * A BOARD'S VERSION HISTORY, read from the vault's own git (🔒 YAZ-1897 D4). Every sync commit is a
 * version, so the history is already there; this only reads it. Nothing here touches the network.
 *
 * A version's `ref` is `<commit>:<path at that commit>` — opaque to the renderer, and exactly what
 * `git show` takes, so a board that was renamed still shows (and restores) its older versions.
 *
 * 🔒 YAZ-1802 D10: a draw.io diagram has a history too. Its version is `{ kind: 'diagram', xml }` —
 * the renderer draws it with the D9 renderer, no change marks in v1 — and a restore goes through
 * `diagram:save`'s own write, so the XML is checked and our D7 dates are stamped like any save.
 */

/** Deep enough for any real board; a history longer than this is not a list anyone scrolls. */
const MAX_VERSIONS = 200

/** A ref this module handed out: a full commit id, a colon, a path. Anything else is refused. */
const REF = /^[0-9a-f]{40}:[^\0]+$/

interface Board {
  bin: string
  root: string
  /** Vault-relative POSIX path of the board as it is now. */
  rel: string
  file: string
}

/**
 * The request's board, validated like its own load door does (`diagram:load` for a `.drawio`,
 * `drawing:load` for anything else); null when the vault has no git to ask.
 */
async function board(root: unknown, rawPath: unknown): Promise<Board | null> {
  const dir = requireAbsPath(root, 'root')
  const file = resolveBoard(dir, rawPath, typeof rawPath === 'string' && isDiagram(rawPath) ? 'diagram' : 'drawing')
  const bin = await resolveGit()
  if (bin === null) return null
  return { bin, root: dir, rel: path.relative(dir, file).split(path.sep).join('/'), file }
}

export async function boardHistory(root: unknown, rawPath: unknown): Promise<BoardVersion[]> {
  const b = await board(root, rawPath)
  if (b === null) return []
  // One record per commit that has the board, renames followed, deletions left out:
  // RS <sha> US <author> US <epoch s> US <Merged-with value> NUL LF <path at that commit> NUL
  const log = await git(b.bin, b.root, ['log', '--follow', '--diff-filter=d', '-z', `-n${MAX_VERSIONS}`, '--format=%x1e%H%x1f%an%x1f%at%x1f%(trailers:key=Merged-with,valueonly,separator=%x2C )', '--name-only', '--', `:(literal)${b.rel}`])
  if (log.code !== 0) return [] // not a repo, or no commits yet
  const versions: BoardVersion[] = []
  for (const record of log.stdout.split('\x1e').slice(1)) {
    const [meta = '', name = ''] = record.split('\0')
    const [sha = '', author = '', at = '0', mergedWith = ''] = meta.split('\x1f')
    versions.push({ ref: `${sha}:${name.trim()}`, author, at: Number(at) * 1000, merged: mergedWith.trim() !== '', localOnly: false })
  }
  const before = await beforeMerge(b, versions)
  if (before !== null) versions.push(before)
  return versions.sort((x, y) => y.at - x.at)
}

/** "Your version before the merge" — only when the last merge left this board different from now. */
async function beforeMerge(b: Board, known: readonly BoardVersion[]): Promise<BoardVersion | null> {
  const blob = async (rev: string) => (await git(b.bin, b.root, ['rev-parse', '--verify', '-q', `${rev}:${b.rel}`])).stdout.trim()
  const then = await blob(BEFORE_MERGE_REF)
  if (then === '' || then === (await blob('HEAD'))) return null
  const commit = await git(b.bin, b.root, ['log', '-1', '--format=%H%x1f%an%x1f%at', BEFORE_MERGE_REF])
  const [sha = '', author = '', at = '0'] = commit.stdout.trim().split('\x1f')
  if (sha === '' || known.some((v) => v.ref.startsWith(`${sha}:`))) return null
  return { ref: `${sha}:${b.rel}`, author, at: Number(at) * 1000, merged: false, localOnly: true }
}

async function readVersion(b: Board, ref: unknown): Promise<string> {
  if (typeof ref !== 'string' || !REF.test(ref)) throw new BridgeFailure('BAD_REQUEST', "'ref' is not a version of this board")
  const shown = await git(b.bin, b.root, ['show', ref], { maxBuffer: isDiagram(b.file) ? MAX_DIAGRAM_BYTES : MAX_DRAWING_BYTES })
  if (shown.code !== 0) throw new BridgeFailure('NOT_FOUND', 'that version is not in this vault', { path: b.file })
  return shown.stdout
}

/** A diagram version's XML; one that is no draw.io document is `IO_ERROR`, as `diagram:load` says of a file. */
async function readDiagramVersion(b: Board, ref: unknown): Promise<string> {
  const xml = await readVersion(b, ref)
  const problem = diagramDocumentError(xml)
  if (problem !== null) throw new BridgeFailure('IO_ERROR', problem, { path: b.file })
  return xml
}

export async function boardVersion(root: unknown, rawPath: unknown, ref: unknown): Promise<BoardVersionScene> {
  const b = await board(root, rawPath)
  if (b === null) throw new BridgeFailure('NOT_FOUND', 'this vault has no git history', { path: String(rawPath) })
  if (isDiagram(b.file)) return { kind: 'diagram', xml: await readDiagramVersion(b, ref) }
  const json = await readVersion(b, ref)
  const { scene, elements } = parseScene(json, b.file, 'IO_ERROR')
  return { kind: 'drawing', json, files: (await resolveFiles(b.root, stripEmbeddedScene(scene).embedded, elements)).files }
}

export async function restoreBoardVersion(root: unknown, rawPath: unknown, ref: unknown): Promise<void> {
  const b = await board(root, rawPath)
  if (b === null) throw new BridgeFailure('NOT_FOUND', 'this vault has no git history', { path: String(rawPath) })
  if (isDiagram(b.file)) {
    await saveDiagram({ root: b.root, path: b.file, xml: await readDiagramVersion(b, ref) })
    return
  }
  const json = await readVersion(b, ref)
  parseScene(json, b.file, 'IO_ERROR') // never write something that is not a scene over a board
  await atomicWrite(b.file, json)
}
