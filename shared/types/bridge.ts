/** `window.yaseenDraw` itself: every namespace of the one door the renderer has. */

import type { AppState, FolderPatch, SIDEBAR_MAX_W, SIDEBAR_MIN_W, SettingsState, SidebarLens, WindowEntry } from './appState'
import type { DiagramApi } from './diagram'
import type { DrawingApi } from './drawing'
import type { BridgeErrorCode } from './errors'
import type { CreateDirResponse, CreateFileRequest, CreateFileResponse, DialogApi, FileClipRequest, FileClipState, FileRenamedEvent, PasteRequest, PasteResponse, PickFolderResponse, RenameFileRequest, RenameFileResponse, TreeResponse, WatchEvent } from './files'
import type { ComponentsApi, MediaApi, SecretsApi } from './library'
import type { ShareApi } from './share'
import type { FavoritesApi, GithubApi, StorageApi } from './vault'

/**
 * Every bridge promise rejects with a plain object satisfying `BridgeError` (the preload
 * unwraps the IPC envelope; `client/src/api.ts` wraps it in `BridgeRequestError`).
 * `CONFLICT` carries the current on-disk `mtime`.
 */
export interface BridgeError {
  code: BridgeErrorCode | 'CONFLICT'
  message: string
  path?: string
  mtime?: number
}

/** Reveal in Finder (GRO-2274): the absolute path to show in the OS file manager. */
export interface RevealRequest {
  path: string
}

/** Reveal in Finder (GRO-2274): echoes the revealed path. */
export interface RevealResponse {
  path: string
}

/** An external-link intent from the canvas; main re-validates the protocol before any OS side effect. */
export interface OpenLinkRequest {
  href: string
}

/** In-app delete (GRO-2272): the absolute path of the entry to move to the system Trash. */
export interface DeleteRequest {
  path: string
}

/** In-app delete (GRO-2272): what moved to the system Trash. */
export interface DeleteResponse {
  path: string
  kind: 'file' | 'dir'
}

/** `file:deleted` — pushed to EVERY window after a successful delete (GRO-2272). */
export interface FileDeletedEvent {
  path: string
  kind: 'file' | 'dir'
}

export interface WindowIdentity {
  id: string
  root: string | null
  file: string | null
  /** Open tabs left→right (GRO-2232); `file` is the active one (same invariants as `WindowEntry.tabs`). */
  tabs: string[]
  /** Whether this window's sidebar is hidden (YAZ-1280). */
  sidebarCollapsed: boolean
  /** Which sidebar lens this window shows (YAZ-847, per window since YAZ-1628). */
  sidebarLens: SidebarLens
  /** Focus Mode's lists (YAZ-1605, per window since YAZ-1628; Favorites' own since YAZ-1766): the same three as `WindowEntry`'s. */
  focusDirs: string[]
  focusFavorites: string[]
}

export interface OpenWindowOptions {
  root: string | null
  file: string | null
}

/** Targeted mutators (not a generic patch) so several windows never lose each other's writes. */
export interface StateApi {
  get(): Promise<AppState>
  setSettings(settings: SettingsState): Promise<void>
  /** Clamped to [SIDEBAR_MIN_W, SIDEBAR_MAX_W] by the main process. */
  setSidebarWidth(width: number): Promise<void>
  /** Prepend to recents (de-duplicated, capped). */
  pushRecent(path: string): Promise<void>
  /** Drop a folder from recents (its directory vanished on disk, C2 — GRO-2164); unknown path is a no-op. */
  removeRecent(path: string): Promise<void>
  /** Merge into `folders[root]`; missing root entries are created with defaults. `name` is cleaned main-side (Docs YAZ-1974 D3). */
  setFolder(root: string, patch: FolderPatch): Promise<void>
  /** Fired in every window after any change; returns an unsubscribe. */
  onChange(listener: (state: AppState) => void): () => void
}

export interface WindowApi {
  /** Who am I: main answers from `AppState.windows` by the `?win=<id>` in the window's URL. */
  identity(): Promise<WindowIdentity>
  /**
   * Record this window's current folder/file/tabs (the window manager persists it). Main
   * re-enforces the tabs invariant against the entry as written (GRO-2232): a non-null `file`
   * missing from `tabs` is prepended; `file: null` clears `tabs`.
   */
  setIdentity(patch: Partial<Pick<WindowIdentity, 'root' | 'file' | 'tabs' | 'sidebarCollapsed' | 'sidebarLens' | 'focusDirs' | 'focusFavorites'>>): Promise<void>
  open(opts: OpenWindowOptions): Promise<void>
  /**
   * The vault switcher's one door (🔒 YAZ-1767 D1): bring a recent vault to the front and bump it
   * to the top of the MRU. Already open in some window(s) → those are RAISED, most recently
   * focused on top, and nothing new opens (🔒 YAZ-1767 D9); not open → a NEW window on that vault's
   * `folders[root].lastFile` (D2). A folder that no longer exists on disk is pruned from the MRU
   * instead and NOTHING opens — the result is `false`, so the row can say "Folder not found" the
   * way Welcome does. The menu's ⌥-click on Open Recent goes through the same door in main.
   */
  openRecent(path: string): Promise<boolean>
  /**
   * Close THIS window through the REAL close path — main calls the managed window's `close()`,
   * so the close/flush handshake runs; never a bare destroy (GRO-2232, e.g. closing the last tab).
   */
  closeSelf(): Promise<void>
  /**
   * The close/quit flush handshake (GRO-2160): main is about to close this window and holds it
   * until every registered listener settled (hard 5s cap in main). Returns an unsubscribe.
   */
  onFlush(listener: () => Promise<void> | void): () => void
}


/**
 * Menu gestures from the main process (B3, GRO-2161): the renderer owns root switching at
 * runtime, so File › Open Folder… / Open Recent land on the focused window's renderer.
 */
/** One ⌘+ / ⌘− / ⌘0 press: up, down, or back to the default (YAZ-1710). */
export type ZoomStep = -1 | 0 | 1

export interface MenuApi {
  /** File › Open Folder… (⌘⇧O) targeted this window: run the pick-folder flow. Returns an unsubscribe. */
  onOpenFolder(listener: () => void): () => void
  /** File › Open Recent chose `path` for this window: switch the root in place. Returns an unsubscribe. */
  onOpenRoot(listener: (path: string) => void): () => void
  /** File › Search Vault (⌘K) targeted this window: focus the sidebar search bar (YAZ-804). Returns an unsubscribe. */
  onSearch(listener: () => void): () => void
  /** File › Switch Vault… (⌘O) targeted this window: open the sidebar header's vault switcher, un-collapsing the sidebar first (YAZ-1767 D8). Returns an unsubscribe. */
  onSwitchVault(listener: () => void): () => void
  /** Yaseen Draw › Settings… (⌘,) targeted this window: open the settings dialog (YAZ-1679). Returns an unsubscribe. */
  onSettings(listener: () => void): () => void
  /** View › Toggle Sidebar targeted this window (YAZ-1280). Returns an unsubscribe. */
  onToggleSidebar(listener: () => void): () => void
  /** File › Close Tab (⌘W) targeted this window: close the active tab (GRO-2232). Returns an unsubscribe. */
  onCloseTab(listener: () => void): () => void
  /** Window › Next Tab (⌃Tab / ⌘⇧]) targeted this window: activate the tab to the right (GRO-2232). Returns an unsubscribe. */
  onNextTab(listener: () => void): () => void
  /** Window › Previous Tab (⌃⇧Tab / ⌘⇧[) targeted this window: activate the tab to the left (GRO-2232). Returns an unsubscribe. */
  onPrevTab(listener: () => void): () => void
  /**
   * File › Export Image… (⌘⇧E, 🔒 YAZ-1775 D10) targeted this window: the VISIBLE drawing opens the
   * engine's own image-export dialog, a visible diagram saves a PNG or SVG (🔒 YAZ-1802 D9). There
   * is no canvas main menu to reach it from any more, so it is the application menu's; main enables
   * the item only while the focused window's active tab is a board. Returns an unsubscribe.
   */
  onExportImage(listener: () => void): () => void
  /**
   * View › Canvas Background › a pick (🔒 YAZ-1775 D10) targeted this window: the VISIBLE drawing takes
   * `color` as its `viewBackgroundColor`, which the engine then writes into the file — the one
   * canvas value that IS per board. Enabled only while the active tab is a drawing. Returns an unsubscribe.
   */
  onCanvasBackground(listener: (color: string) => void): () => void
  /**
   * File › Export Drawing… (⌘⇧S, 🔒 YAZ-1775 D3, YAZ-1821) targeted this window: the VISIBLE drawing
   * assembles a standalone `.excalidraw` with every image embedded and offers it to a save sheet.
   * Enabled only while the active tab is a drawing. Returns an unsubscribe.
   */
  onExportDrawing(listener: () => void): () => void
  /** File › Share Link (⌘⇧L, YAZ-1799): open the Share dialog for the visible board, a drawing or a diagram (🔒 YAZ-1802 D11). */
  onShareLink(listener: () => void): () => void
}

/**
 * File lifecycle beyond create/write (Links E1, GRO-2194): in-app rename with automatic
 * link updates. `rename` is the invoke; `onRenamed` is the push every window receives after
 * ANY successful rename (its own included), used to remap open tabs to the new path.
 */
export interface FileApi {
  /** Same-directory FILE rename, extension kind unchanged; never overwrites (`ALREADY_EXISTS`). */
  rename(req: RenameFileRequest): Promise<RenameFileResponse>
  /** Fired in every window after a successful rename; returns an unsubscribe. */
  onRenamed(listener: (ev: FileRenamedEvent) => void): () => void
  /**
   * In-app delete (GRO-2272): move a file or folder to the SYSTEM TRASH and repair the app
   * state. `shell.trashItem` only — never `fs.rm`, and no permanent-delete fallback: a trash
   * failure rejects `IO_ERROR` and the entry stays on disk, because a filesystem with no
   * Trash is exactly where destroying the file would be worst.
   *
   * Refuses (`BAD_REQUEST`) dot-entries — invisible infrastructure the UI never showed — and
   * the CALLING window's own vault root (root identity is a recents/vault question, same
   * split as `rename`); another window rooted inside a deleted folder is allowed and falls
   * through to that window's existing `onRootMissing` repair. Missing path → `NOT_FOUND`.
   * There is no extension gate: the tree shows every folder, so every folder is deletable.
   *
   * On success the same handler drops every stored reference (`store.removePath`: window
   * `file` — promoted to an heir tab rather than nulled when other tabs survive — plus tabs,
   * recents and folder state) and pushes `file:deleted` to EVERY window. The tree needs no
   * push: the watcher's `unlink` / `unlinkDir` echo heals it (trashItem is a MOVE at the fs layer).
   */
  delete(req: DeleteRequest): Promise<DeleteResponse>
  /** Fired in every window after a successful delete; returns an unsubscribe. */
  onDeleted(listener: (ev: FileDeletedEvent) => void): () => void
  /**
   * Cut / Copy (YAZ-1674, D1): replaces the ONE app-wide clipboard in main with the ordered
   * selection and the verb. Nothing touches the disk here — a stale entry is reported per
   * entry at paste time. Every window then receives `clip:changed`. Rejects `BAD_REQUEST`
   * (bad `op`, empty `paths`) or `NOT_ABSOLUTE` (a relative entry) and leaves the clipboard as it was.
   */
  clip(req: FileClipRequest): Promise<void>
  /**
   * Paste (YAZ-1674, D2–D4) INTO `targetDir`, which must exist (`NOT_FOUND` / `NOT_A_DIRECTORY`,
   * never created); an empty clipboard rejects `BAD_REQUEST`. Per entry, in clipboard order:
   * a COPY is `fs.cp` under a free name (folders whole, hidden dirs inside included, timestamps
   * kept) with no store repair and no push — nothing moved, the watcher's add echo fills the
   * tree; a CUT is the EXISTING rename pipeline (store repair + `file:renamed` to every window
   * per entry), so tabs follow. A cut clears the clipboard once at least one entry landed; a
   * copy keeps it. One bad entry never stops the rest — read `failed` for the notices.
   */
  paste(req: PasteRequest): Promise<PasteResponse>
  /**
   * The CURRENT app-wide clipboard (YAZ-1674): for a window that mounts AFTER a clip — it
   * missed the push, so it reads once on mount; `onClipChanged` carries every later change.
   * Same shape as the push: `{ count, op }`, or null when empty. Never fails.
   */
  clipState(): Promise<FileClipState>
  /** Fired in every window after every clipboard change (its own included); null = empty. Returns an unsubscribe. */
  onClipChanged(listener: (state: FileClipState) => void): () => void
}

/**
 * OS-level actions (GRO-2274). Its own namespace rather than a member of `FileApi`: revealing
 * is not a file operation, and whatever OS action comes next (open-in-terminal, open-with)
 * belongs beside it rather than scattered across the file API.
 */
export interface ShellApi {
  /**
   * Show `path` in the OS file manager, selected IN ITS PARENT (`shell.showItemInFolder`) —
   * files, folders and the vault root alike. Not `openPath`: the verb is "Reveal", and VS Code
   * and Obsidian both behave this way. A path that no longer exists rejects `NOT_FOUND` rather
   * than silently doing nothing, so a stale row can surface a passive notice. Read-only, so
   * unlike `delete`/`rename` there is no dot-entry or extension guard.
   */
  reveal(req: RevealRequest): Promise<RevealResponse>
  /**
   * Open `path` in VS Code through the OS deep link (`vscode://file/<path>`, every segment
   * percent-encoded) — LOCKED: `shell.openExternal`, never a spawned process, so the app
   * couples to the scheme rather than to an install location or a `code` on PATH, and the OS
   * picks which VS Code answers. Files, folders and the vault root alike; what opening a folder
   * means is VS Code's decision. Same request/response shape and the same read-only posture as
   * `reveal`, stat included: a path that no longer exists rejects `NOT_FOUND`.
   */
  openVsCode(req: RevealRequest): Promise<RevealResponse>
  /**
   * Hand `path` to the OS default application (YAZ-1577) — how a tree row with no in-app viewer
   * (`kind: null`) opens. Files, folders and the vault root alike. Same request/response shape and
   * read-only posture as `reveal`, stat included: a path that no longer exists rejects `NOT_FOUND`;
   * an OS refusal (`shell.openPath`'s returned message) rejects `IO_ERROR` carrying that message.
   */
  openDefault(req: RevealRequest): Promise<RevealResponse>
}

/**
 * Deep links (E1, GRO-2171): main parses a `yaseendraw://` URL (`shared/links.ts`) and routes
 * it to the best window; these are the pushes the routed-to renderer receives.
 */
export interface LinkApi {
  /** A link resolved to this window: open `path` (guaranteed inside this window's root). Returns an unsubscribe. */
  onOpenFile(listener: (path: string) => void): () => void
  /** A link could not be opened (bad URL, unsupported, missing or non-regular file): show `message` unobtrusively. Returns an unsubscribe. */
  onNotice(listener: (message: string) => void): () => void
}

/**
 * The single typed surface the renderer uses for everything outside the DOM, installed by
 * the preload as `window.yaseenDraw` (`contextBridge`, `ipcMain.handle` on the main side).
 * Request/response shapes are the ones above; new methods are additive only.
 */
export interface YaseenDrawApi {
  tree(root: string): Promise<TreeResponse>
  createDir(path: string): Promise<CreateDirResponse>
  createFile(req: CreateFileRequest): Promise<CreateFileResponse>
  /** The drawing DOCUMENT's two doors (🔒 YAZ-1810): the only way a `.excalidraw` tab reads and writes. */
  drawing: DrawingApi
  /** The draw.io DIAGRAM document's two doors (🔒 YAZ-1802 D6): the only way a `.drawio` tab reads and writes. */
  diagram: DiagramApi
  /** Native open-directory dialog parented to the calling window (GRO-2163). */
  pickFolder(): Promise<PickFolderResponse>
  /** Native file dialogs: pick a `.excalidraw` to import (YAZ-1833). */
  dialog: DialogApi
  /** One chokidar watcher per root in main, shared by every window; late joiners get `ready` at once. */
  watch(root: string, listener: (ev: WatchEvent) => void): () => void
  state: StateApi
  window: WindowApi
  menu: MenuApi
  link: LinkApi
  /** In-app file rename + the renamed push (Links E1, GRO-2194). */
  file: FileApi
  /** OS-level actions: Reveal in Finder (GRO-2274) and Open in VS Code (YAZ-963). */
  shell: ShellApi
  /** The Favorites list over `.yaseendraw/favorites.json` (YAZ-1766 6A) — absolute paths in, relative on disk. */
  favorites: FavoritesApi
  /** The cross-vault media library over `<library>/media.json` (🔒 YAZ-1775 D4 / D5, YAZ-1817). */
  media: MediaApi
  /** The cross-vault saved-component library over `<library>/components/` (🔒 YAZ-1775 D5, YAZ-1819). */
  components: ComponentsApi
  /** Encrypted secrets in `userData/secrets.json` (🔒 YAZ-1775 D4) — write and ask, never read. */
  secrets: SecretsApi
  /** Per-vault GitHub sync, off by default (YAZ-1081). */
  github: GithubApi
  /** Settings › Storage: what the vault weighs, and moving legacy pictures out of boards (YAZ-1801). */
  storage: StorageApi
  /** Share link (YAZ-1799): main owns Cloudflare and the secrets; the renderer hands over bytes. */
  share: ShareApi
}
