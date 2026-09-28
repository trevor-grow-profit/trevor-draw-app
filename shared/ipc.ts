/**
 * THE BRIDGE, DECLARED ONCE (YAZ-2073 🔒 D16). `CONTRACT` is every channel `window.yaseenDraw`
 * reaches, as data: an `invoke` is a request main answers (`ipcMain.handle`), a `push` is an event
 * main sends and a renderer subscribes to with `on…(listener)`, which returns its unsubscribe. The
 * preload builds the bridge from this table, main registers its handlers against it, the renderer's
 * `api` wraps it, and `YaseenDrawApi` is derived from it — so the allowlist stays fixed at build
 * time and a missing or mistyped door fails to compile. `watch` and `window.onFlush` are the two
 * hand-written specials (`SPECIAL`). Long form: docs/CONTRACTS.md › Bridge API.
 */
import type { AppState, BoardVersion, BoardVersionScene, BridgeError, ComponentItem, ComponentReadResponse, ComponentRenameRequest, ComponentSaveRequest, ComponentSlugRequest, CreateDirResponse, CreateFileRequest, CreateFileResponse, DeleteRequest, DeleteResponse, DiagramLoadRequest, DiagramLoadResponse, DiagramSaveRequest, DiagramSaveResponse, DrawingLoadRequest, DrawingLoadResponse, DrawingSaveRequest, DrawingSaveResponse, FileClipRequest, FileClipState, FileDeletedEvent, FileRenamedEvent, FolderPatch, GithubSyncStatus, MediaFavoritesRequest, MediaImportRequest, MediaImportResponse, MediaPreviewRequest, MediaPreviewResponse, MediaRecentRequest, MediaSearchRequest, MediaSearchResponse, OpenDrawingResponse, OpenWindowOptions, PasteRequest, PasteResponse, PickFolderResponse, RenameFileRequest, RenameFileResponse, RevealRequest, RevealResponse, SaveDrawingRequest, SaveDrawingResponse, SaveImageRequest, SecretHasRequest, SecretSetRequest, SettingsState, ShareAccount, ShareBoardRequest, ShareEntry, ShareListEntry, SharePermissionRequest, SharePublishRequest, ShareSetupProgress, ShareStatus, ShrinkResult, StoredMediaItem, TreeResponse, VaultStorageStats, WatchEvent, WindowIdentity } from './types'

/** A request main answers. The type parameters are phantom: only `kind` and `channel` exist at runtime. */
export interface Invoke<A extends unknown[], R> {
  readonly kind: 'invoke'
  readonly channel: string
  readonly types?: (...args: A) => R
}

/** An event main sends; `T` is its payload (`void` for none). */
export interface Push<T> {
  readonly kind: 'push'
  readonly channel: string
  readonly payload?: T
}

/** A door by its channel — how `CONTRACT` declares every invoke, and how a test makes a door of its own. */
export const invoke = <A extends unknown[], R>(channel: string): Invoke<A, R> => ({ kind: 'invoke', channel })
const push = <T = void>(channel: string): Push<T> => ({ kind: 'push', channel })

export const CONTRACT = {
  /** The folder tree; the first one for a root also runs that vault's orphan sweep (🔒 YAZ-1775 D3). */
  tree: invoke<[root: string], TreeResponse>('fs:tree'),
  createDir: invoke<[path: string], CreateDirResponse>('fs:create-dir'),
  createFile: invoke<[req: CreateFileRequest], CreateFileResponse>('fs:create-file'),
  /**
   * The drawing DOCUMENT's two doors (🔒 YAZ-1810), one per direction and the only way a `.excalidraw`
   * tab reads and writes: a scene and the bytes it names are ONE thing, so a load is "the scene, then
   * its images" and a save is "the images, then the scene", atomically.
   */
  drawing: {
    load: invoke<[req: DrawingLoadRequest], DrawingLoadResponse>('drawing:load'),
    save: invoke<[req: DrawingSaveRequest], DrawingSaveResponse>('drawing:save'),
    /** The RESOLVED library folder (🔒 YAZ-1775 D5): the setting, or `<userData>/library` — only main knows where userData is. */
    libraryFolder: invoke<[], string>('drawing:library-folder'),
  },
  /** The draw.io DIAGRAM document's two doors (🔒 YAZ-1802 D6): text in, text out, the same mtime guard; main stamps the dates (D7). */
  diagram: {
    load: invoke<[req: DiagramLoadRequest], DiagramLoadResponse>('diagram:load'),
    save: invoke<[req: DiagramSaveRequest], DiagramSaveResponse>('diagram:save'),
  },
  /** The native open-directory dialog, parented to the calling window (GRO-2163). */
  pickFolder: invoke<[], PickFolderResponse>('dialog:pick-folder'),
  dialog: {
    /** Pick one `.excalidraw` OUTSIDE the vault and get its bytes back; `{ cancelled: true }` when dismissed (YAZ-1833). */
    openDrawing: invoke<[], OpenDrawingResponse>('dialog:open-file'),
    /** The native SAVE sheet and the write behind it: a standalone `.excalidraw` outside the vault (🔒 YAZ-1775 D3, YAZ-1821). */
    saveDrawing: invoke<[req: SaveDrawingRequest], SaveDrawingResponse>('dialog:save-file'),
    /** The same sheet for a diagram's picture: PNG or SVG, by the picked extension (🔒 YAZ-1802 D9). */
    saveImage: invoke<[req: SaveImageRequest], SaveDrawingResponse>('dialog:save-image'),
  },
  /** Targeted mutators (not a generic patch) so several windows never lose each other's writes. */
  state: {
    get: invoke<[], AppState>('state:get'),
    setSettings: invoke<[settings: SettingsState], void>('state:set-settings'),
    /** Clamped to [SIDEBAR_MIN_W, SIDEBAR_MAX_W] by main. */
    setSidebarWidth: invoke<[width: number], void>('state:set-sidebar-width'),
    /** Prepend to recents (de-duplicated, capped). */
    pushRecent: invoke<[path: string], void>('state:push-recent'),
    /** Drop a folder whose directory vanished (C2, GRO-2164); an unknown path is a no-op. */
    removeRecent: invoke<[path: string], void>('state:remove-recent'),
    /** Merge into `folders[root]`, created with defaults if missing; `name` is cleaned main-side (YAZ-1974 D3). */
    setFolder: invoke<[root: string, patch: FolderPatch], void>('state:set-folder'),
    /** Every change, in every window. */
    onChange: push<AppState>('state:changed'),
  },
  window: {
    /** Who am I: main answers from `AppState.windows` by the `?win=<id>` in the window's URL. */
    identity: invoke<[], WindowIdentity>('window:identity'),
    /** Record this window's folder/file/tabs; main re-enforces the tabs invariant (GRO-2232). */
    setIdentity: invoke<[patch: Partial<Omit<WindowIdentity, 'id'>>], void>('window:set-identity'),
    open: invoke<[opts: OpenWindowOptions], void>('window:open'),
    /**
     * The vault switcher's door (🔒 YAZ-1767 D1, D9): raise the windows already on that vault, or open a
     * new one on its `lastFile`. `false` = the folder is gone and was pruned from the MRU; nothing opened.
     */
    openRecent: invoke<[path: string], boolean>('window:open-recent'),
    /** Close THIS window through the real close path, so the flush handshake runs (GRO-2232). */
    closeSelf: invoke<[], void>('window:close-self'),
  },
  /** Menu gestures (GRO-2161; tabs GRO-2232): main sends these to the focused window only. */
  menu: {
    onOpenFolder: push('menu:open-folder'),
    onOpenRoot: push<string>('menu:open-root'),
    onSearch: push('menu:search'),
    /** File › Switch Vault… (⌘O): open the header's vault switcher, un-collapsing the sidebar first (YAZ-1767 D8). */
    onSwitchVault: push('menu:switch-vault'),
    onSettings: push('menu:settings'),
    onToggleSidebar: push('menu:toggle-sidebar'),
    onCloseTab: push('menu:close-tab'),
    onNextTab: push('menu:next-tab'),
    onPrevTab: push('menu:prev-tab'),
    /**
     * The canvas gestures that left the engine's own menu (🔒 YAZ-1775 D10), routed to the VISIBLE board
     * and enabled by main only while the focused window's active tab is one they work for: Export
     * Image… (a diagram too, 🔒 YAZ-1802 D9), Canvas Background (a drawing's `viewBackgroundColor`),
     * Export Drawing… (YAZ-1821) and Share Link (any board, YAZ-1799, 🔒 YAZ-1802 D11).
     */
    onExportImage: push('menu:export-image'),
    onCanvasBackground: push<string>('menu:canvas-background'),
    onExportDrawing: push('menu:export-drawing'),
    onShareLink: push('menu:share-link'),
  },
  /** Deep links (E1, GRO-2171): main routes a `yaseendraw://` URL to the best window. */
  link: {
    /** Open this path, guaranteed inside this window's root. */
    onOpenFile: push<string>('link:open-file'),
    /** A link that could not be opened: show the message unobtrusively. */
    onNotice: push<string>('link:notice'),
  },
  /**
   * The file lifecycle (Links E1 GRO-2194, GRO-2272, YAZ-1674): each change is one invoke plus a push to
   * EVERY window. Rename never overwrites (`ALREADY_EXISTS`). Delete is `shell.trashItem` only, never
   * `fs.rm`; neither touches the calling window's own root. Cut/Copy fill main's ONE app-wide
   * clipboard; a paste reports per entry (`failed`), a cut moving through the rename pipeline.
   */
  file: {
    rename: invoke<[req: RenameFileRequest], RenameFileResponse>('fs:rename'),
    onRenamed: push<FileRenamedEvent>('file:renamed'),
    delete: invoke<[req: DeleteRequest], DeleteResponse>('fs:delete'),
    onDeleted: push<FileDeletedEvent>('file:deleted'),
    clip: invoke<[req: FileClipRequest], void>('fs:clip'),
    paste: invoke<[req: PasteRequest], PasteResponse>('fs:paste'),
    /** The clipboard now, for a window that mounted after a clip; `{ count, op }`, or null when empty. Never fails. */
    clipState: invoke<[], FileClipState>('fs:clip-state'),
    onClipChanged: push<FileClipState>('clip:changed'),
  },
  /** OS hand-offs (GRO-2274, YAZ-963, YAZ-1577), read-only: a path that no longer exists rejects `NOT_FOUND`. */
  shell: {
    /** Show it in the OS file manager, selected in its parent. */
    reveal: invoke<[req: RevealRequest], RevealResponse>('shell:reveal'),
    /** Open it in VS Code through `vscode://file/…` — `shell.openExternal`, never a spawned process. */
    openVsCode: invoke<[req: RevealRequest], RevealResponse>('shell:openVsCode'),
    /** Hand it to the OS default app; an OS refusal rejects `IO_ERROR` with its message. */
    openDefault: invoke<[req: RevealRequest], RevealResponse>('shell:openDefault'),
  },
  /** The Favorites list over `.yaseendraw/favorites.json` (YAZ-1766 6A): absolute paths in the user's order. */
  favorites: {
    /** `[]` when the file is absent or malformed; never creates anything. */
    get: invoke<[root: string], string[]>('favorites:get'),
    /** Replace the list; every path must be inside `root` (`BAD_REQUEST`); a malformed file is `INVALID_CONFIG`. */
    set: invoke<[root: string, paths: readonly string[]], void>('favorites:set'),
    /** Any change to a vault's favorites.json, own or external; filter by `root`. */
    onChanged: push<{ root: string }>('favorites:changed'),
  },
  /** The cross-vault media library over `<library>/media.json` (🔒 YAZ-1775 D5, YAZ-1817) and the Image Studio's providers (D4, YAZ-1818). */
  media: {
    /** List / add / remove; every verb answers the list it produced. */
    favorites: invoke<[req: MediaFavoritesRequest], StoredMediaItem[]>('media:favorites'),
    /** List the MRU, or record a use. */
    recent: invoke<[req: MediaRecentRequest], StoredMediaItem[]>('media:recent'),
    /** `media.json` changed — any vault, any writer. */
    onChanged: push('media:changed'),
    /** Federated search: main fetches, curates and caches, so the renderer never holds a key or reaches a provider. */
    search: invoke<[req: MediaSearchRequest], MediaSearchResponse>('media:search'),
    /** One tile's picture as a dataURL, from main's 24 h disk cache when it is there. */
    preview: invoke<[req: MediaPreviewRequest], MediaPreviewResponse>('media:preview'),
    /** The full-size bytes, NEVER cached: they are about to become an `assets/` file (🔒 YAZ-1775 D3). */
    import: invoke<[req: MediaImportRequest], MediaImportResponse>('media:import'),
  },
  /** The cross-vault saved-component library over `<library>/components/` (🔒 YAZ-1775 D5, YAZ-1819). */
  components: {
    /** The index, newest-updated first, reconciled against the folder. */
    list: invoke<[], ComponentItem[]>('components:list'),
    save: invoke<[req: ComponentSaveRequest], ComponentItem>('components:save'),
    read: invoke<[req: ComponentSlugRequest], ComponentReadResponse>('components:read'),
    /** The label only; both files keep their names. */
    rename: invoke<[req: ComponentRenameRequest], ComponentItem>('components:rename'),
    /** Both files to the OS trash, and the row out of the index. */
    delete: invoke<[req: ComponentSlugRequest], void>('components:delete'),
    /** The stored `<slug>.png` as a dataURL; `NOT_FOUND` when it is gone. */
    preview: invoke<[req: ComponentSlugRequest], string>('components:preview'),
    onChanged: push('components:changed'),
  },
  /** The secrets door (🔒 YAZ-1775 D4): write and ask, never read — no channel answers a value. */
  secrets: {
    set: invoke<[req: SecretSetRequest], void>('secrets:set'),
    has: invoke<[req: SecretHasRequest], boolean>('secrets:has'),
  },
  /** Per-vault GitHub sync (YAZ-1081); every call answers the same status the push carries. */
  github: {
    /** `off` for a vault with sync disabled, never a failure. */
    status: invoke<[root: string], GithubSyncStatus>('github:status'),
    /** Run a pass now; one already running is joined, never raced. */
    syncNow: invoke<[root: string], GithubSyncStatus>('github:sync-now'),
    /** The per-vault switch: ON answers the first pass's real outcome, OFF is immediate and total. */
    setEnabled: invoke<[root: string, enabled: boolean], GithubSyncStatus>('github:set-enabled'),
    /** Every transition of any vault, in every window; filter by `status.root`. */
    onStatus: push<GithubSyncStatus>('github:status-changed'),
    /** Version history (YAZ-1897 D4): a board's committed versions, newest first. */
    history: invoke<[root: string, path: string], BoardVersion[]>('github:history'),
    /** One version: a drawing's scene and pictures, or a diagram's XML (🔒 YAZ-1802 D10). */
    version: invoke<[root: string, path: string, ref: string], BoardVersionScene>('github:version'),
    /** Write that version over the board as an ordinary edit. */
    restore: invoke<[root: string, path: string, ref: string], void>('github:restore'),
  },
  /** Settings › Storage (YAZ-1801): what the vault weighs (disk + local git, never the network), and moving legacy pictures out of boards. */
  storage: {
    stats: invoke<[root: string], VaultStorageStats>('storage:stats'),
    /** `skip` = absolute paths with unsaved edits in a tab; an unreadable board counts as skipped. */
    shrink: invoke<[root: string, skip: readonly string[]], ShrinkResult>('storage:shrink'),
  },
  /** Share links (YAZ-1799): main owns Cloudflare, the token and the upload password; the renderer hands over bytes. */
  share: {
    status: invoke<[], ShareStatus>('share:status'),
    /** The Cloudflare accounts a pasted key sees — more than one means a picker. */
    accounts: invoke<[token: string], ShareAccount[]>('share:accounts'),
    /** Provision everything from one pasted token; progress arrives on `onSetupProgress`. */
    setup: invoke<[token: string, accountId?: string], ShareStatus>('share:setup'),
    onSetupProgress: push<ShareSetupProgress>('share:setup-progress'),
    /** Cloudflare's "create API token" page (the fake one in the demo), in the browser. */
    openCloudflare: invoke<[], void>('share:open-cloudflare'),
    get: invoke<[req: ShareBoardRequest], ShareEntry | null>('share:get'),
    /** `check: false` skips the live check (no network): the sidebar badges' call. */
    list: invoke<[root: string, check?: boolean], ShareListEntry[]>('share:list'),
    /** First share (new id), or the automatic re-upload after a save (same id, permission untouched). */
    publish: invoke<[req: SharePublishRequest], ShareEntry>('share:publish'),
    /** "View and download" / "view only" on the SAME link — no re-upload. */
    setPermission: invoke<[req: SharePermissionRequest], ShareEntry>('share:set-permission'),
    /** Delete the object (the link dies at once) and forget the record. */
    stop: invoke<[req: ShareBoardRequest], void>('share:stop'),
    setDomain: invoke<[hostname: string | null], ShareStatus>('share:set-domain'),
    /** Forget the token and password; `deleteEverything` first wipes every object, the Worker and the bucket. */
    disconnect: invoke<[root: string | null, deleteEverything: boolean], ShareStatus>('share:disconnect'),
    /** Any status or shares.json change, in every window. */
    onChanged: push('share:changed'),
  },
} as const

/** The two hand-written specials' channels. */
export const SPECIAL = {
  /** `watch(root, listener)`: one shared watcher per root in main; events are multiplexed by subscription id. */
  watchSubscribe: 'watch:subscribe',
  watchUnsubscribe: 'watch:unsubscribe',
  watchEvent: 'watch:event',
  /** The close/quit flush handshake (GRO-2160): main sends `app:flush` and holds the window until `app:flushed`. */
  appFlush: 'app:flush',
  appFlushed: 'app:flushed',
} as const

/** A table's leaves become functions: an invoke resolves its answer, a push subscribes and returns the unsubscribe. */
export type Bridge<C> = {
  -readonly [K in keyof C]: C[K] extends Invoke<infer A, infer R> ? (...args: A) => Promise<R> : C[K] extends Push<infer T> ? (listener: (payload: T) => void) => () => void : Bridge<C[K]>
}

/** `window.yaseenDraw`: the table, plus the two specials. Every invoke rejects with a plain `BridgeError`. */
export type YaseenDrawApi = Bridge<typeof CONTRACT> & {
  /** One watcher per root in main (`fs/treeWatcher.ts`), shared by every window; late joiners get `ready` at once. */
  watch(root: string, listener: (ev: WatchEvent) => void): () => void
  window: {
    /** Main is about to close this window and holds it until every listener settled (5 s cap in main). */
    onFlush(listener: () => Promise<void> | void): () => void
  }
}

/**
 * Every `ipcMain.handle` answers with an envelope: Electron serialises a thrown Error down to its
 * message, so a structured `BridgeError` must travel as data. The preload unwraps it.
 */
export type Envelope<T> = { ok: true; value: T } | { ok: false; error: BridgeError }

export const isLeaf = (v: unknown): v is Invoke<unknown[], unknown> | Push<unknown> => typeof (v as { channel?: unknown }).channel === 'string'
