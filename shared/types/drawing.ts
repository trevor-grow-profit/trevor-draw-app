/** The drawing DOCUMENT's two doors' shapes and the image bytes that travel with a scene (🔒 YAZ-1810). */

/**
 * One image the canvas holds, as it crosses the bridge: the engine's own mime plus a base64
 * `data:` URL. Deliberately NOT the engine's `BinaryFileData` — the bridge must not depend on a
 * renderer package, and `created`/`lastRetrieved` are the engine's bookkeeping, not the file's.
 */
export interface DrawingFileEntry {
  mimeType: string
  /** `data:<mime>;base64,<payload>` — the only form either side accepts. */
  dataURL: string
}

export interface DrawingLoadRequest {
  /** Vault root; the document must resolve inside it. */
  root: string
  /** The document, vault-relative or absolute under `root`. Never a basename search. */
  path: string
  /**
   * For a PICTURE of the scene, never an editor (🔒 YAZ-2073 D6): the longest side, in pixels, of
   * the image the scene is drawn into. Each picture then comes back no bigger than it can appear
   * there — a PNG thumbnail made in main — or as its own bytes when it cannot be smaller.
   */
  imageMaxPx?: number
}

export interface DrawingLoadResponse {
  /** Absolute path that was read — what every later save addresses. */
  path: string
  /**
   * The file's bytes as UTF-8 text, exactly as they sit on disk — except that a LEGACY scene's
   * embedded `files` map comes back empty (🔒 YAZ-2073 D7): those bytes travel once, in `files`.
   */
  json: string
  /** Disk mtime of the read: the `expectedMtime` the first save goes back with. */
  mtime: number
  size: number
  /**
   * Every image the scene still references and whose bytes were found, keyed by `fileId`. An id
   * with no bytes anywhere is simply absent — the engine draws its placeholder and the document
   * still opens (🔒 YAZ-1775 D3).
   */
  files: Record<string, DrawingFileEntry>
  /**
   * The subset of `files` that came from the STORE rather than from the file's own embedded
   * `files` map. The renderer never ships these back (they are already on disk); anything else
   * it holds is `newFiles` on the next save.
   */
  stored: string[]
}

/** One image a save must land in the store before the scene that names it is written. */
interface DrawingNewFile extends DrawingFileEntry {
  /** Excalidraw's own content id (the SHA-1 of the bytes) — the file's name under `assets/`. */
  fileId: string
}

export interface DrawingSaveRequest {
  root: string
  path: string
  /** The serialized scene. Written verbatim but for the store's own `files: {}` rewrite (🔒 YAZ-1775 D3). */
  json: string
  /** The mtime the renderer last read or wrote; a differing disk mtime rejects `CONFLICT` and writes NOTHING — assets included. */
  expectedMtime?: number
  /** Images the store does not have yet. Written first, so the scene on disk never names bytes that are missing. */
  newFiles: DrawingNewFile[]
}

export interface DrawingSaveResponse {
  path: string
  mtime: number
  size: number
  /** The ids now on disk — the renderer adds them to its persisted set so it never ships them twice. */
  persisted: string[]
}

