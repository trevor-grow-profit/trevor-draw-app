/** The account-wide library (🔒 YAZ-1775 D5) and the providers and secrets behind it (🔒 YAZ-1775 D4). */

/**
 * Where the media a board can reach comes from (the web app's `ImageStudioProvider`, ported
 * verbatim): Pixabay photos and illustrations, Iconify icons and logos, and the app's own shapes.
 * `shape` needs no network and no key at all.
 */
export type MediaProvider = 'pixabay' | 'iconify' | 'shape'
const MEDIA_PROVIDERS: readonly MediaProvider[] = ['pixabay', 'iconify', 'shape']
export const isMediaProvider = (v: unknown): v is MediaProvider => MEDIA_PROVIDERS.includes(v as MediaProvider)

/** What the item IS, independent of who served it (the web app's `ImageStudioItemKind`). */
export type MediaItemKind = 'photo' | 'illustration' | 'icon' | 'logo' | 'shape'
const MEDIA_ITEM_KINDS: readonly MediaItemKind[] = ['photo', 'illustration', 'icon', 'logo', 'shape']
export const isMediaItemKind = (v: unknown): v is MediaItemKind => MEDIA_ITEM_KINDS.includes(v as MediaItemKind)

/**
 * A POINTER to something a provider can serve — never the bytes. Field for field the web app's
 * `mediaItemValidator` (`convex/mediaTypes.ts`) so a library written by either app reads in the
 * other: `itemKey` is the identity (de-dupe and removal both key on it), the rest is attribution
 * and layout metadata the studio shows.
 *
 * `previewUrl` is stored but NEVER TRUSTED: a provider's CDN URL expires, and a stale one in a
 * file that syncs between machines would render a broken tile. YAZ-1818 re-derives every preview it
 * shows from `provider` + `providerId` and treats this field as a hint at best.
 */
export interface MediaItem {
  itemKey: string
  provider: MediaProvider
  providerId: string
  kind: MediaItemKind
  title: string
  previewUrl?: string
  creator?: string
  creatorUrl?: string
  collectionName?: string
  sourceUrl?: string
  licenseName?: string
  licenseUrl?: string
  attribution?: string
  width?: number
  height?: number
  trademarkNotice?: boolean
}

/**
 * A `MediaItem` as the library FILE holds it — the web app's `storedItemValidator`: the pointer
 * plus the moment it was last favorited or used. `updatedAt` is stamped by the main process on
 * every write and is what both lists are ordered by (newest first); a renderer never supplies it.
 */
export type StoredMediaItem = MediaItem & { updatedAt: number }

/**
 * `<library>/media.json` (🔒 YAZ-1775 D5): the cross-vault media library, ONE file for the whole account.
 * Both lists are newest-first and de-duplicated by `itemKey`; `favorites` is the user's pinned
 * set, `recent` is an MRU of what they actually placed on a board.
 */
export interface MediaLibraryFile {
  version: 1
  favorites: StoredMediaItem[]
  recent: StoredMediaItem[]
}

/** The library file's name inside the library folder. */
export const MEDIA_LIBRARY_FILE = 'media.json'
/**
 * `<library>/components/` (🔒 YAZ-1775 D5): where YAZ-1819 writes a saved component's `.excalidraw` + `.png`.
 * Named here so nothing else claims it; YAZ-1817 creates NOTHING — the folder appears on YAZ-1819's first write.
 */
export const LIBRARY_COMPONENTS_DIR = 'components'
/** The components index beside that folder: `<library>/components.json` (🔒 YAZ-1775 D5, YAZ-1819). */
export const COMPONENTS_INDEX_FILE = 'components.json'
/** Favorites are capped at the web app's `listFavorites` ceiling; the oldest fall off the end. */
export const MAX_MEDIA_FAVORITES = 500
/** The MRU's length, the web app's `RECENT_LIMIT` exactly. */
export const RECENT_LIMIT = 60

/** `media:favorites` — one channel, three verbs; every verb answers the resulting list. */
export type MediaFavoritesRequest = { op: 'list' } | { op: 'add'; item: MediaItem } | { op: 'remove'; itemKey: string }
/** `media:recent` — the same shape: read the MRU, or push an item to its head. */
export type MediaRecentRequest = { op: 'list' } | { op: 'record'; item: MediaItem }

// ---------- Image Studio: the provider doors (🔒 YAZ-1775 D4, YAZ-1818) ----------

/**
 * Which providers a search asks. The web app's `ImageStudioSearchSource` exactly: `all` is the
 * federated mix (Iconify 14 + Pixabay 4 of `SEARCH_LIMIT` 18), the other two are one provider each.
 */
export type MediaSearchSource = 'all' | 'iconify' | 'pixabay'
const MEDIA_SEARCH_SOURCES: readonly MediaSearchSource[] = ['all', 'iconify', 'pixabay']
export const isMediaSearchSource = (v: unknown): v is MediaSearchSource => MEDIA_SEARCH_SOURCES.includes(v as MediaSearchSource)

/**
 * A search RESULT — the same pointer `media.json` stores, so favoriting one is a copy rather than
 * a conversion. It carries NO `previewUrl`: in the web app that field held the Worker route that
 * would serve the picture, and this app has no routes — a preview is asked for by `provider` +
 * `providerId` over `media:preview`, which is also why a stored `previewUrl` is never trusted.
 */
export type StudioItem = MediaItem

/** The two providers that serve BYTES; `shape` is drawn by the renderer and never fetched. */
export type MediaBytesProvider = 'pixabay' | 'iconify'
const MEDIA_BYTES_PROVIDERS: readonly MediaBytesProvider[] = ['pixabay', 'iconify']
export const isMediaBytesProvider = (v: unknown): v is MediaBytesProvider => MEDIA_BYTES_PROVIDERS.includes(v as MediaBytesProvider)

/** `media:search` — the query, the providers, and the opaque cursor of the page before this one. */
export interface MediaSearchRequest {
  q: string
  source: MediaSearchSource
  /** The `nextCursor` of the previous page; absent or null starts over. Opaque: main minted it, main reads it. */
  cursor?: string | null
}

/**
 * `media:search`'s answer. `nextCursor` is null when the providers are exhausted — that is what
 * stops the infinite scroll. `pixabayAvailable` is the ONE thing the renderer learns about the
 * key (🔒 YAZ-1775 D4: never the value): false hides the Pixabay section instead of showing an error.
 */
export interface MediaSearchResponse {
  items: StudioItem[]
  nextCursor: string | null
  pixabayAvailable: boolean
  /** A provider that was reached and failed while ANOTHER answered — the web app's warning banner. */
  warnings: string[]
}

/** `media:preview` / `media:import` — a provider and its own id for the item. */
export interface MediaBytesRequest {
  provider: MediaBytesProvider
  id: string
}
export type MediaPreviewRequest = MediaBytesRequest
export type MediaImportRequest = MediaBytesRequest

/** The tile picture. A dataURL because the renderer is sandboxed and there is no custom protocol. */
export interface MediaPreviewResponse {
  mimeType: string
  dataURL: string
}

/**
 * The full-size bytes, plus the item as the PROVIDER describes it now — which is how a Recent row
 * gets a fresh size and attribution even when the caller's copy came out of an old `media.json`.
 * Only the fields main can actually know are set; the caller's own item supplies the rest.
 */
export interface MediaImportResponse extends MediaPreviewResponse {
  item: StudioItem
}


// ---------- Saved components (`<library>/components/` — 🔒 YAZ-1775 D5, YAZ-1819) ----------

/**
 * ONE saved component as the index names it (🔒 YAZ-1775 D5). The SLUG is the identity: it is the file's
 * own basename (`<library>/components/<slug>.excalidraw` + `<slug>.png`), so the folder can be
 * read back into an index with nothing else on hand. The NAME is only the label, which is why a
 * rename never moves a file — a component inserted into a board is not addressed by either.
 */
export interface ComponentItem {
  slug: string
  name: string
  elementCount: number
  createdAt: number
  updatedAt: number
}

/** `<library>/components.json`: the index, rebuilt from the folder whenever it is missing or unreadable. */
export interface ComponentsIndexFile {
  version: 1
  items: ComponentItem[]
}

/**
 * `components:save` — the fragment and its picture, both already made by the renderer (only it has
 * an engine). `fragmentJson` is a whole `.excalidraw` document with the component's image bytes
 * EMBEDDED (🔒 YAZ-1775 D5: a component is small and self-contained, so it inserts into any vault);
 * `previewPng` is a `data:image/png;base64,…` dataURL, which is the only way bytes cross the bridge.
 */
export interface ComponentSaveRequest {
  name: string
  fragmentJson: string
  previewPng: string
}

/** `components:read` / `components:delete` / `components:preview` — a component by its slug. */
export interface ComponentSlugRequest {
  slug: string
}

/** `components:rename` — the label only; the slug, and therefore both files, stay put. */
export interface ComponentRenameRequest {
  slug: string
  name: string
}

/** `components:read`'s answer: the fragment's bytes, exactly as they are on disk. */
export interface ComponentReadResponse {
  fragmentJson: string
}

/** The longest name a component may carry — the web app's `MAX_SAVED_COMPONENT_NAME_LENGTH`. */
export const MAX_COMPONENT_NAME_LENGTH = 120

// ---------- Secrets (`userData/secrets.json` — 🔒 YAZ-1775 D4) ----------

/** `secrets:set` — a value to store, or null to clear the name entirely. */
export interface SecretSetRequest {
  name: string
  value: string | null
}

/** `secrets:has` — the ONLY question a renderer may ask about a secret. */
export interface SecretHasRequest {
  name: string
}

/** The name the Pixabay API key is stored under (🔒 YAZ-1775 D4); YAZ-1818 reads it in main, never here. */
export const PIXABAY_SECRET = 'pixabayApiKey'

