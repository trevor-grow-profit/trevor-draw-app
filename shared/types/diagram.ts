/**
 * The draw.io DIAGRAM document's two doors (🔒 YAZ-1802 D6) — the diagram twin of `drawing.ts`,
 * minus the images: a diagram's pictures live inside its own XML, so a load is the text and its
 * mtime, and a save is the text back under the same mtime guard.
 */

export interface DiagramLoadRequest {
  /** Vault root; the document must resolve inside it. */
  root: string
  /** The `.drawio`, vault-relative or absolute under `root`. */
  path: string
}

export interface DiagramLoadResponse {
  /** Absolute path that was read — what every later save addresses. */
  path: string
  /** The file's XML exactly as it sits on disk (compressed pages included — draw.io inflates them). */
  xml: string
  /** Disk mtime of the read: the `expectedMtime` the first save goes back with. */
  mtime: number
  size: number
}

export interface DiagramSaveRequest {
  root: string
  path: string
  /** The document as draw.io serialised it: plain `<mxfile>` XML (🔒 YAZ-1802 D3). */
  xml: string
  /** The mtime the renderer last read or wrote; a differing disk mtime rejects `CONFLICT` and writes NOTHING. */
  expectedMtime?: number
}

export interface DiagramSaveResponse {
  path: string
  mtime: number
  size: number
}

