/**
 * THE LIBRARY'S COMPONENT STORE (🔒 YAZ-1775 D5, YAZ-1819): `<library>/components/<slug>.excalidraw` +
 * `<slug>.png`, indexed by `<library>/components.json`, shared by every vault's windows. The rules
 * live in `@shared/savedComponents`; this module is the disk half — read lazily, write atomically,
 * trash through the OS, watch for the other writers.
 *
 * THE FOLDER IS THE TRUTH, THE INDEX IS A CACHE. Every read reconciles the index against what is
 * actually in `components/`: a fragment the index does not know is adopted (named after its own
 * slug, counted by reading it once), a row whose file has gone drops out, and an index that is
 * missing or is not a version-1 index at all is rebuilt from the folder — the corrupt one moved
 * aside as `components.json.corrupt-<epoch>`, the `store.ts` posture. This is what makes a
 * component that arrived through a synced folder show up without anything having to repair itself,
 * and what makes a file deleted in Finder stop being offered.
 *
 * A READ NEVER WRITES. The reconciliation happens in memory; the file is only ever written by a
 * mutation, which writes the reconciled index WITH its change. So listing a library on a read-only
 * disk works, and nothing churns a synced folder just by being looked at.
 *
 * Mutations serialise on one promise chain (two windows saving in the same tick are two
 * read-modify-writes and interleaving them would lose one), and a mutation that changes nothing
 * does not write.
 *
 * Watching is `watchedFolder.ts`'s, at depth 1 — `components.json` beside `components/`, and
 * everything inside it — pushed to every window as `components:changed`. An own write notifies
 * this process's subscribers synchronously and its watcher echo is dropped by path + mtime.
 *
 * THE FOLDER SCAN IS CACHED ON ITS OWN mtime. Reconciling costs a `readdir` plus a `stat` per
 * fragment, and `components:changed` makes every window re-list; a folder whose mtime has not
 * moved since the last scan cannot have gained or lost a file, so that scan is reused.
 *
 * TRASH, NEVER `rm` (the app's rule for every delete): `shell.trashItem` comes in as an argument,
 * so this module stays Electron-free and its tests run on a temp folder with a spy.
 */
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  COMPONENTS_INDEX_FILE,
  LIBRARY_COMPONENTS_DIR,
  type ComponentItem,
  type ComponentRenameRequest,
  type ComponentSaveRequest,
  type ComponentSlugRequest,
  type ComponentsIndexFile,
} from '@shared/types'
import {
  EMPTY_COMPONENTS_INDEX,
  componentFileName,
  componentPreviewName,
  indexFromSlugs,
  isValidComponentSlug,
  normalizeComponentName,
  parseComponentFragment,
  putComponentItem,
  removeComponentItem,
  renameComponentItem,
  sanitizeComponentsIndex,
  slugForComponentName,
  slugOfComponentFile,
  slugOfComponentPreview,
  uniqueComponentSlug,
  type ComponentOnDisk,
} from '@shared/savedComponents'
import { parseDataUrl } from '@shared/drawingAssets'
import { BridgeFailure, atomicWrite, fsCall } from '../fs/fsUtils'
import { createChain, createWatchedFolder, readOrQuarantine } from '../watchedFolder'

/** The one preview format (🔒 YAZ-1775 D5): the renderer exports PNG, and nothing else is stored. */
const PREVIEW_MIME = 'image/png'

export interface ComponentStore {
  /** The reconciled index, newest-updated first. */
  list(): Promise<ComponentItem[]>
  /** Write both files and index them; answers the row it made. */
  save(req: ComponentSaveRequest): Promise<ComponentItem>
  /** The fragment's bytes, exactly as they are on disk. */
  read(req: ComponentSlugRequest): Promise<string>
  /** The label only — both files keep their names. */
  rename(req: ComponentRenameRequest): Promise<ComponentItem>
  /** Both files to the trash, and the row out of the index. */
  delete(req: ComponentSlugRequest): Promise<void>
  /** The stored preview as a `data:image/png;base64,…` dataURL. */
  preview(req: ComponentSlugRequest): Promise<string>
  /** Point at another library folder (the setting changed); the old one goes quiet. */
  setFolder(folder: string): void
  /** Fires after any change to the components library — an own write or an external one. */
  onChanged(listener: () => void): () => void
  close(): Promise<void>
}

export function createComponentStore(initialFolder: string, deps: { now?: () => number; trash: (p: string) => Promise<void> }): ComponentStore {
  const now = deps.now ?? Date.now
  const trash = deps.trash
  const listeners = new Set<() => void>()
  const chain = createChain()
  let folder = initialFolder
  /** The last folder scan, kept while `components/`'s own mtime says nothing was added or removed. */
  let scanCache: { dir: string; mtimeMs: number; disk: ComponentOnDisk[] } | null = null

  const indexFile = (): string => path.join(folder, COMPONENTS_INDEX_FILE)
  const componentsDir = (): string => path.join(folder, LIBRARY_COMPONENTS_DIR)
  const fragmentPath = (slug: string): string => path.join(componentsDir(), componentFileName(slug))
  const previewPath = (slug: string): string => path.join(componentsDir(), componentPreviewName(slug))
  const notify = (): void => listeners.forEach((l) => l())

  /** The index file alone, with a file that is not one moved aside. Never creates anything. */
  const readIndexFile = async (): Promise<ComponentsIndexFile> =>
    (await readOrQuarantine(indexFile(), sanitizeComponentsIndex, 'components', 'a valid components index')) ?? EMPTY_COMPONENTS_INDEX

  /**
   * What the folder holds: one entry per readable `<slug>.excalidraw`, counted only when it is new.
   * Reused while `components/`'s own mtime is unchanged — a directory mtime moves on every add and
   * every remove, which is exactly what this scan is looking for, and every window re-lists on
   * every `components:changed`.
   */
  async function scanFolder(known: ComponentsIndexFile): Promise<ComponentOnDisk[]> {
    const dir = componentsDir()
    const dirStat = await stat(dir).catch(() => null)
    if (dirStat === null) return []
    if (scanCache !== null && scanCache.dir === dir && scanCache.mtimeMs === dirStat.mtimeMs) return scanCache.disk
    let names: string[]
    try {
      names = await readdir(dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const bySlug = new Map(known.items.map((item) => [item.slug, item]))
    const seen: ComponentOnDisk[] = []
    for (const name of names) {
      const slug = slugOfComponentFile(name)
      if (slug === null) continue
      const p = path.join(dir, name)
      const st = await stat(p).catch(() => null)
      if (st === null || !st.isFile()) continue
      const row = bySlug.get(slug)
      if (row !== undefined) {
        seen.push({ slug, elementCount: row.elementCount, createdAt: row.createdAt, updatedAt: row.updatedAt })
        continue
      }
      // Unknown to the index: count it once, by reading it. A fragment that is not a component —
      // corrupt, truncated, someone else's JSON — is SKIPPED rather than offered as a tile that
      // cannot be inserted.
      const count = await readFile(p, 'utf8')
        .then((text) => parseComponentFragment(text).elements.length)
        .catch(() => null)
      if (count === null) {
        console.warn(`[components] ${p} is not a readable component; skipped`)
        continue
      }
      const birth = Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs
      seen.push({ slug, elementCount: count, createdAt: birth, updatedAt: st.mtimeMs })
    }
    scanCache = { dir, mtimeMs: dirStat.mtimeMs, disk: seen }
    return seen
  }

  /** The index as the folder and the file together imply it. Pure reads — nothing is written. */
  async function readIndex(): Promise<ComponentsIndexFile> {
    const known = await readIndexFile()
    return indexFromSlugs(await scanFolder(known), known)
  }

  async function writeBytes(p: string, content: string | Uint8Array): Promise<void> {
    const { mtime } = await fsCall(p, async () => {
      await mkdir(path.dirname(p), { recursive: true })
      return atomicWrite(p, content)
    })
    watched.noteOwnWrite(p, mtime)
    scanCache = null // this process just changed the folder; the next read scans it again
  }

  async function writeIndex(index: ComponentsIndexFile): Promise<void> {
    await writeBytes(indexFile(), `${JSON.stringify(index, null, 2)}\n`)
  }

  /** One read-modify-write on the chain; `fn` does the file work and answers the index to store. */
  const mutate = <T,>(fn: (index: ComponentsIndexFile) => Promise<{ index: ComponentsIndexFile; value: T }>): Promise<T> =>
    chain.run(async () => {
      const before = await readIndex()
      const { index, value } = await fn(before)
      if (index !== before) {
        await writeIndex(index)
        notify()
      }
      return value
    })

  function requireSlug(slug: string): string {
    if (!isValidComponentSlug(slug)) throw new BridgeFailure('BAD_REQUEST', "'slug' is not a component slug")
    return slug
  }

  const componentsOf = (dir: string): string => path.join(dir, LIBRARY_COMPONENTS_DIR)

  const watched = createWatchedFolder({
    dir: initialFolder,
    // Depth 1: `components.json` sits beside `components/`, and what is INSIDE that folder is the
    // library itself — a synced fragment arrives there without the index ever being touched.
    depth: 1,
    tag: 'components',
    /**
     * The index, and the two files a component IS. Anything else under `components/` is silence,
     * the way `mediaStore`'s depth-0 filter names `media.json` and nothing else.
     */
    relevant: (p, dir) => {
      if (p === path.join(dir, COMPONENTS_INDEX_FILE)) return true
      if (path.dirname(p) !== componentsOf(dir)) return false
      const name = path.basename(p)
      return slugOfComponentFile(name) !== null || slugOfComponentPreview(name) !== null
    },
    // `components/` may have come into existence DURING the watcher's own start, which the polling
    // fallback can lose (`fs/treeWatcher.ts`). Re-adding it once at `ready` is the recovery; on a
    // path that still does not exist it does nothing, and the parent watch picks it up when it is made.
    alsoWatch: (dir) => [componentsOf(dir)],
    onChange: () => {
      scanCache = null // somebody else changed the folder
      notify()
    },
  })

  return {
    async list() {
      return chain.run(readIndex).then((index) => index.items)
    },

    async save(req) {
      const name = normalizeComponentName(req.name)
      if (name === null) throw new BridgeFailure('BAD_REQUEST', "'name' must be a non-empty string")
      let elementCount: number
      try {
        elementCount = parseComponentFragment(req.fragmentJson).elements.length
      } catch (err) {
        throw new BridgeFailure('BAD_REQUEST', `'fragmentJson' is not a component: ${err instanceof Error ? err.message : String(err)}`)
      }
      const preview = parseDataUrl(req.previewPng)
      if (preview === null || preview.mimeType !== PREVIEW_MIME) throw new BridgeFailure('BAD_REQUEST', "'previewPng' must be a base64 image/png dataURL")
      const bytes = Buffer.from(preview.base64, 'base64')
      return mutate(async (index) => {
        const taken = new Set(index.items.map((item) => item.slug))
        // `requireSlug`'s own rule, applied BEFORE anything is written: a name that only produces
        // an over-long slug is refused here rather than becoming a tile that can never be read,
        // previewed or deleted.
        const slug = requireSlug(uniqueComponentSlug(slugForComponentName(name), taken))
        const at = now()
        // The fragment's own bytes, as the renderer serialised them: a component IS an Excalidraw
        // document, and re-spelling it here would only make the two disagree.
        await writeBytes(fragmentPath(slug), req.fragmentJson.endsWith('\n') ? req.fragmentJson : `${req.fragmentJson}\n`)
        await writeBytes(previewPath(slug), bytes)
        const item: ComponentItem = { slug, name, elementCount, createdAt: at, updatedAt: at }
        return { index: putComponentItem(index, item), value: item }
      })
    },

    async read(req) {
      const slug = requireSlug(req.slug)
      const p = fragmentPath(slug)
      return fsCall(p, () => readFile(p, 'utf8'))
    },

    async rename(req) {
      const slug = requireSlug(req.slug)
      const name = normalizeComponentName(req.name)
      if (name === null) throw new BridgeFailure('BAD_REQUEST', "'name' must be a non-empty string")
      return mutate(async (index) => {
        const next = renameComponentItem(index, slug, name, now())
        if (next === index) throw new BridgeFailure('NOT_FOUND', 'no such component', { path: fragmentPath(slug) })
        return { index: next, value: next.items.find((item) => item.slug === slug) as ComponentItem }
      })
    },

    async delete(req) {
      const slug = requireSlug(req.slug)
      return mutate(async (index) => {
        const next = removeComponentItem(index, slug)
        if (next === index) throw new BridgeFailure('NOT_FOUND', 'no such component', { path: fragmentPath(slug) })
        // Both files, and a preview that is already gone is not a failure — the fragment is the
        // component, the picture is a convenience.
        const fragment = fragmentPath(slug)
        await fsCall(fragment, async () => {
          await trash(fragment)
          watched.noteOwnWrite(fragment, null)
        })
        const preview = previewPath(slug)
        await trash(preview).then(
          () => watched.noteOwnWrite(preview, null),
          () => undefined,
        )
        scanCache = null
        return { index: next, value: undefined }
      })
    },

    async preview(req) {
      const slug = requireSlug(req.slug)
      const p = previewPath(slug)
      const bytes = await fsCall(p, () => readFile(p))
      return `data:${PREVIEW_MIME};base64,${bytes.toString('base64')}`
    },

    setFolder(next) {
      if (next === folder) return
      folder = next
      scanCache = null
      watched.setFolder(next)
    },

    onChanged(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    close() {
      listeners.clear()
      return watched.close()
    },
  }
}
