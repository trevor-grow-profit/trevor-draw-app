import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { SIDEBAR_MAX_W, SIDEBAR_MIN_W, type CanvasPanelState, type CanvasPrefs, type SettingsState, type SidebarLens } from '@shared/types'
import { prefsEqual } from '@shared/canvasPrefs'
import { isWithin } from '@shared/paths'
import { api, BridgeRequestError } from './api'
import { requestBoardCommand } from './drawings/boardCommand'
import { Editor } from './Editor'
import { useGithubSync } from './hooks/useGithubSync'
import { useVaultStorage } from './hooks/useVaultStorage'
import { useSharing } from './share/useSharing'
import { useLinkEvents } from './hooks/useLinkEvents'
import { useMenuEvents } from './hooks/useMenuEvents'
import { usePickFolder } from './hooks/usePickFolder'
import { useWatch } from './hooks/useWatch'
import { fileClipboardVerb } from './lib/fileClipboardHotkey'
import { LINK_NOTICE_MS, type Notice, type NoticeKind } from './lib/notice'
import { NoticeIcon } from './components/NoticeIcon'
import { basename, vaultPath } from './lib/paths'
import { flushRenamedDir, flushRenamedPath, retireDir, retirePath } from './lib/renameContinuity'
import { EMPTY_SELECTION } from './lib/selection'
import { storage } from './lib/storage'
import { ownsSidebarHotkey } from './lib/sidebarHotkey'
import { attentionCopy, buildSetupPrompt } from './lib/syncAttention'
import { resolveTheme, useSystemPrefersDark } from './lib/theme'
import { fileHash } from './lib/urlHash'
import { useVaultName } from './lib/useVaultName'
import { windowTitle } from './lib/windowTitle'
import { SettingsDialog } from './settings/SettingsDialog'
import type { SettingsSectionId } from './settings/registry'
import { ShareDialog } from './share/ShareDialog'
import { VersionHistory } from './history/VersionHistory'
import { mergeNotice } from './history/mergeNotice'
import { noteBoardSaved } from './share/liveShare'
import { noteBoardRenamed } from './share/liveShare'
import { type SidebarClipboard, Sidebar } from './sidebar/Sidebar'
import type { SidebarRevealRequest } from './sidebar/revealRow'
import { TabBar } from './tabs/TabBar'
import { useWorkspace } from './workspace/useWorkspace'
import { Welcome } from './Welcome'

/** Reflect the open file in the URL (GRO-2069); replaceState keeps Back sane. */
function syncHash(path: string | null): void {
  history.replaceState(null, '', fileHash(path) || location.pathname + location.search)
}

export function App() {
  const [root, setRoot] = useState<string | null>(storage.getRoot)
  // Workspace (Tabs I2 + YAZ-966): one renderer-owned model, seeded from the boot identity snapshot
  // (a pasted `#/abs/path.excalidraw` URL wins as the active tab — bootTabs). The ACTIVE tab is this
  // window's `file`: title, URL hash and the sidebar highlight all follow it.
  const {
    tabs, active: file, mounted, openCurrent, openBackground, activate, close: closeTab, move: moveTab,
    closeActive, next: nextTab, prev: prevTab, back, forward, canBack, canForward, reset: resetTabs,
    renamePath: renameWorkspacePath, renameDirPath: renameWorkspaceDir, deletePath: deleteWorkspacePath, deleteDirPath: deleteWorkspaceDir,
  } = useWorkspace(root)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(storage.getSidebarCollapsed)
  const sidebarCollapsedRef = useRef(sidebarCollapsed)
  const [sidebarWidth, setSidebarWidth] = useState(storage.getSidebarWidth)
  // The sidebar's active LENS (🔒 YAZ-1775 D4, YAZ-847): App-owned and persisted because the Sidebar is
  // mounted `key={root}` and only while open; sidebar-local view state would reset on every
  // collapse/reopen and root switch. Window identity like visibility since YAZ-1628 — one
  // `WindowEntry.sidebarLens`; never a second flag.
  const [sidebarLens, setSidebarLens] = useState(storage.getSidebarLens)
  // ⌘C / ⌘X / ⌘V's handle (D6 amended, YAZ-1674): the mounted Sidebar's two verbs, null while collapsed.
  const sidebarClipboard = useRef<SidebarClipboard | null>(null)
  const sidebarRevealId = useRef(0)
  const [sidebarRevealRequest, setSidebarRevealRequest] = useState<SidebarRevealRequest | null>(null)
  const [resizing, setResizing] = useState(false)
  const [settings, setSettings] = useState(storage.getSettings)
  const watch = useWatch(root)
  // GitHub sync (YAZ-1081 YAZ-1817/YAZ-1818), owned here for the same reason: ONE per window. Two surfaces
  // read it — the editor's chip (every mounted tab) and the settings cog's section — and they
  // must never disagree, which two hooks watching the same root eventually would.
  const githubSync = useGithubSync(root)
  // The attention banner (YAZ-1818): passive — `role="status"`, explicit buttons, never a modal. Sync
  // failing is not worth stealing focus over; the vault still works, and the drawing in front of
  // the user is untouched.
  //
  // Dismissal is per-PROBLEM, not per-session: it resets on ANY transition of state or reason,
  // so a retry that fails again — or a different failure — says so rather than staying silent
  // because the user waved off an earlier one.
  const [syncDismissed, setSyncDismissed] = useState(false)
  const syncState = githubSync.status?.state ?? null
  const syncReason = githubSync.status?.attention ?? null
  useEffect(() => {
    setSyncDismissed(false)
  }, [syncState, syncReason])
  const syncCopy = githubSync.status === null ? null : attentionCopy(githubSync.status)
  // YAZ-1801 D3: the files the last pass held back (over GitHub's limit), as ABSOLUTE paths for the
  // sidebar's cloud-off icons, in the root's own separator (`vaultPath`). Read off the ONE status
  // above — never a second subscription — so the banner, the chip and the tree always agree.
  const tooLargeList = githubSync.status?.tooLarge
  const tooLargePaths = useMemo<ReadonlySet<string>>(() => new Set(root === null ? [] : (tooLargeList ?? []).map((rel) => vaultPath(root, rel))), [root, tooLargeList])
  // ⌘K's half of the search-bar focus handshake (YAZ-801, wired in YAZ-804): `openSearch` sets it
  // (including the collapsed case, which un-collapses and mounts the sidebar with the flag already
  // true); the sidebar focuses its input and clears it through the callback.
  const [pendingSearchFocus, setPendingSearchFocus] = useState(false)
  const searchFocusHandled = useCallback(() => setPendingSearchFocus(false), [])

  // Settings and sidebar width are global. Visibility (YAZ-1280) and the lens (YAZ-1628) are
  // window identity and never follow another renderer's `state:changed` broadcast.
  useEffect(
    () =>
      storage.subscribe(() => {
        setSettings(storage.getSettings())
        setSidebarWidth(storage.getSidebarWidth())
      }),
    [],
  )

  const toggleSidebar = useCallback(() => {
    const next = !sidebarCollapsedRef.current
    sidebarCollapsedRef.current = next
    storage.setSidebarCollapsed(next)
    setSidebarCollapsed(next)
  }, [])

  // Renderer bubble phase is deliberate: the canvas and other focused tools get first ownership.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!ownsSidebarHotkey(event)) return
      event.preventDefault()
      toggleSidebar()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleSidebar])

  // Dragging past 60% of the minimum reads as "close it" rather than "make it tiny" — the
  // sidebar collapses and the remembered width stays whatever it was before the drag.
  const startSidebarResize = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault()
      const start = sidebarWidth
      const x0 = e.clientX
      let raw = start
      let width = start
      const move = (ev: MouseEvent) => {
        raw = start + ev.clientX - x0
        width = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, raw))
        // Paint-only while dragging: the CSS var, not React state — App renders when the drag starts
        // and when it lands, never per pixel (YAZ-2073 5D).
        document.documentElement.style.setProperty('--side-w', `${width}px`)
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        document.body.style.cursor = ''
        setResizing(false)
        if (raw < SIDEBAR_MIN_W * 0.6) {
          document.documentElement.style.setProperty('--side-w', `${start}px`)
          toggleSidebar()
        } else if (width !== start) {
          setSidebarWidth(width)
          storage.setSidebarWidth(width)
        }
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
      document.body.style.cursor = 'col-resize'
      setResizing(true)
    },
    [sidebarWidth, toggleSidebar],
  )

  const changeSettings = useCallback((next: SettingsState) => {
    storage.setSettings(next)
    setSettings(next)
  }, [])

  // 🔒 YAZ-1775 D9: the canvas prefs are ONE value in the shell store, and every mounted canvas in every
  // window reads it. The engine (or the rail) reports a change up here; the store broadcasts it;
  // the surfaces apply what actually moved. A ref carries the current settings so the callback
  // identity never changes — a new one would re-render the memoized `<Excalidraw>`.
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const changeCanvasPrefs = useCallback(
    (canvas: CanvasPrefs) => {
      // Compare before writing, on this side too: an engine that re-reports the value it was just
      // handed must not start a write loop.
      if (prefsEqual(settingsRef.current.canvas, canvas)) return
      changeSettings({ ...settingsRef.current, canvas })
    },
    [changeSettings],
  )
  /** 🔒 YAZ-1775 D10: the canvas panel's last-used tab and dock preference, remembered app-wide. */
  const changeCanvasPanel = useCallback(
    (canvasPanel: CanvasPanelState) => {
      const current = settingsRef.current.canvasPanel
      if (current.tab === canvasPanel.tab && current.docked === canvasPanel.docked) return
      changeSettings({ ...settingsRef.current, canvasPanel })
    },
    [changeSettings],
  )

  /** A lens tab click (YAZ-847): write through to this window's identity, then mirror it locally. */
  const changeLens = useCallback((next: SidebarLens) => {
    storage.setSidebarLens(next)
    setSidebarLens(next)
  }, [])

  // Appearance (Desktop K, GRO-2218): `system` tracks the OS live; explicit values win.
  // `data-theme` goes on <html> so body / fixed overlays follow app.css's dark tokens.
  // storage.init() resolves before the first render, so the first paint is already themed.
  const prefersDark = useSystemPrefersDark()
  const theme = resolveTheme(settings.theme, prefersDark)
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  // The sidebar's width rides on <html> beside `data-theme` rather than through a React style
  // prop: it is one custom property, and this keeps the app root free of an inline style object.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--side-w', `${sidebarWidth}px`)
  }, [sidebarWidth])

  // The URL hash mirrors the ACTIVE tab (GRO-2069; rule 17: on boot the hash already won as
  // the active tab in bootTabs, so this first run is a no-op re-write of the same hash).
  useEffect(() => syncHash(file), [file])

  // The OS window title mirrors what is open (C3, GRO-2165) under the vault's display name (Docs YAZ-1974 D4); Electron follows document.title.
  const vaultName = useVaultName(root)
  useEffect(() => {
    document.title = windowTitle(vaultName, file)
  }, [vaultName, file])

  /**
   * Switch this window to `path` in place (C3, GRO-2165) — the WELCOME window, the vault menu's
   * explicit "Open in this window" (YAZ-1941 D2) and the switcher's ⇧⏎ / ⇧-click (Docs YAZ-1974 D8);
   * every other open from a vault window goes beside (YAZ-1913). Resolves false — and drops the dead
   * MRU entry — when the folder is gone on disk (C2), leaving the window as it is; any other
   * probe failure still switches, and the sidebar surfaces the error.
   */
  const openRoot = useCallback(async (path: string): Promise<boolean> => {
    try {
      await api.tree(path)
    } catch (err) {
      if (err instanceof BridgeRequestError && (err.code === 'NOT_FOUND' || err.code === 'NOT_A_DIRECTORY')) {
        storage.removeRecentRoot(path)
        return false
      }
    }
    storage.setRoot(path) // ONE identity write (Tabs rule 13) — a different root also resets file, tabs, lens and focus: see `storage.setRoot`
    storage.pushRecentRoot(path)
    setSidebarLens(storage.getSidebarLens()) // a different vault lands on Files (Docs YAZ-1846 D2); the same one keeps its tab
    setSidebarRevealRequest(null)
    setRoot(path)
    // The folder's remembered file becomes the sole restored tab (D6); reset mirrors it down.
    resetTabs(path, storage.getLastFile(path))
    return true
  }, [resetTabs])

  // A vault window never has its vault swapped (YAZ-1913 🔒 D2): a picked folder goes to main's one
  // open-recent door (a new window, or that vault's windows raised). Only Welcome fills in place.
  const openPicked = useCallback((path: string) => {
    if (root === null) void openRoot(path)
    else void api.window.openRecent(path).catch((err: unknown) => console.error('[open-folder] openRecent failed:', err))
  }, [root, openRoot])
  const { pick, picking } = usePickFolder({ onPicked: openPicked })

  // ⌘W ladder (Tabs rule 7): close the active tab; with zero tabs open (incl. Welcome) close
  // the WINDOW through the real close path so the close/flush handshake runs.
  const closeTabOrWindow = useCallback(() => {
    if (!closeActive()) void api.window.closeSelf()
  }, [closeActive])

  // ⌘K (D4, YAZ-804): un-collapse this window through the one persisted toggle path, then ask
  // the sidebar to focus its search bar (it mounts with the flag already true).
  const openSearch = useCallback(() => {
    if (sidebarCollapsed) toggleSidebar()
    setPendingSearchFocus(true)
  }, [sidebarCollapsed, toggleSidebar])

  // ⌘O (YAZ-1767 D8): the ⌘K handshake for the vault switcher — un-collapse first, then bump a
  // request counter the sidebar header's panel consumes. The request is pinned to the root it was
  // made on: the Sidebar remounts `key={root}`, and a stale counter must not reopen the panel on
  // the new root of a vault that was just moved or renamed. Welcome (root null) has no switcher.
  const [switcherRequest, setSwitcherRequest] = useState<{ seq: number; root: string | null }>({ seq: 0, root: null })
  const openVaultSwitcher = useCallback(() => {
    if (root === null) return
    if (sidebarCollapsed) toggleSidebar()
    setSwitcherRequest((prev) => ({ seq: prev.seq + 1, root }))
  }, [root, sidebarCollapsed, toggleSidebar])

  const showInSidebar = useCallback((path: string) => {
    if (sidebarCollapsed) toggleSidebar()
    // Favorites is a SUBSET of the vault (YAZ-1766 D1): a reveal there hops to Files, where every row exists.
    const lens = sidebarLens === 'favorites' ? 'files' : sidebarLens
    if (lens !== sidebarLens) changeLens(lens)
    setSidebarRevealRequest({ id: ++sidebarRevealId.current, path, lens })
  }, [sidebarCollapsed, sidebarLens, toggleSidebar, changeLens])

  // A folder search row (🔒 YAZ-1775 D3, YAZ-1491): always the FILES lens, whichever tab was showing. The
  // sidebar is necessarily open (the row was clicked in it), so no un-collapse step here.
  const revealInFiles = useCallback((path: string) => {
    changeLens('files')
    setSidebarRevealRequest({ id: ++sidebarRevealId.current, path, lens: 'files' })
  }, [changeLens])

  const consumeSidebarReveal = useCallback((id: number) => {
    setSidebarRevealRequest((request) => request?.id === id ? null : request)
  }, [])

  // The settings dialog (YAZ-1679) is App's so the sidebar cog, ⌘, and the app menu's Settings…
  // open the ONE dialog — and it can open with the sidebar collapsed. `open`/`close` are stable
  // because `useMenuEvents` resubscribes whenever a callback identity changes.
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Which standalone page the dialog opens on — the Share dialog's "Open Settings › Sharing" (YAZ-1799).
  const [settingsPage, setSettingsPage] = useState<SettingsSectionId | undefined>(undefined)
  const openSettings = useCallback(() => {
    setSettingsPage(undefined)
    setSettingsOpen(true)
  }, [])
  const openSharingSettings = useCallback(() => {
    setSettingsPage('sharing')
    setSettingsOpen(true)
  }, [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  // Settings › Storage (YAZ-1801 D1, 🔒 D13): measured only while Settings is open — on its page's
  // open, a sync pass finishing, and a shrink. A closed dialog hands the hook no sync state at all.
  const vaultStorage = useVaultStorage(root, settingsOpen ? syncState : null)
  // Settings › Sharing (YAZ-1799 D7): main's share status and this vault's shared boards, read only while Settings is open.
  const sharing = useSharing(root, settingsOpen)
  // The ONE Share dialog (YAZ-1799 D6): File › Share Link (the active board) and the sidebar's "Share".
  const [sharePath, setSharePath] = useState<string | null>(null)
  const fileRef = useRef(file)
  fileRef.current = file
  const shareActive = useCallback(() => {
    if (fileRef.current !== null) setSharePath(fileRef.current)
  }, [])
  // Version history (YAZ-1897 D4): the sidebar's right-click, or "See changes" on a merge notice (`fromMerge`).
  const [history, setHistory] = useState<{ path: string; fromMerge: boolean } | null>(null)
  const openHistory = useCallback((path: string) => setHistory({ path, fromMerge: false }), [])

  // File › Open Folder… / Open Recent (GRO-2161) reuse the same flows as the in-app buttons;
  // File › Close Tab and Window › Next/Previous Tab (GRO-2232) drive the tab model.
  // 🔒 YAZ-1775 D10: File › Export Image… and View › Canvas Background act on the VISIBLE board layer,
  // which `requestBoardCommand` finds by DOM — several tabs are mounted at once and only one is
  // in front. Main greys each item out off a board it does not work for, so a miss here is already impossible.
  const exportImage = useCallback(() => void requestBoardCommand({ kind: 'export-image' }), [])
  const setCanvasBackground = useCallback((color: string) => void requestBoardCommand({ kind: 'canvas-background', color }), [])
  const exportDrawing = useCallback(() => void requestBoardCommand({ kind: 'export-drawing' }), [])
  useMenuEvents({
    onOpenFolder: pick,
    onOpenRoot: openRoot,
    onSearch: openSearch,
    onSwitchVault: openVaultSwitcher,
    onSettings: openSettings,
    onToggleSidebar: toggleSidebar,
    onCloseTab: closeTabOrWindow,
    onNextTab: nextTab,
    onPrevTab: prevTab,
    onExportImage: exportImage,
    onCanvasBackground: setCanvasBackground,
    onExportDrawing: exportDrawing,
    onShareLink: shareActive,
  })

  // Deep links (E1, GRO-2171): a routed link behaves like a sidebar click (Tabs rule 10) —
  // it activates the file's tab when already open, else opens it in the CURRENT tab;
  // a link that could not open shows a transient notice — unobtrusive, never a dialog.
  const [notice, setNotice] = useState<Notice | null>(null)
  // The one door every surface uses (D10 amended, YAZ-1674): text plus an optional glyph kind,
  // `'info'` unless the caller names one — so nothing that already said `onNotice(text)` changed.
  const notify = useCallback((text: string, icon: NoticeKind = 'info') => setNotice({ text, icon }), [])
  useEffect(() => {
    if (notice === null || notice.action !== undefined) return
    const timer = setTimeout(() => setNotice(null), LINK_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [notice])
  useLinkEvents({ onOpenFile: openCurrent, onNotice: notify })

  // A sync pass that merged says so ONCE (YAZ-1897 D4): `merged` rides only that pass's broadcast.
  // A shared board the merge rewrote re-uploads its link, as a local save would (`liveShare`).
  const merged = githubSync.status?.merged
  useEffect(() => {
    if (merged === undefined || merged.length === 0 || root === null) return
    const { text, firstBoard } = mergeNotice(merged)
    const run = firstBoard === null ? null : () => setHistory({ path: vaultPath(root, firstBoard), fromMerge: true })
    setNotice(run === null ? { text, icon: 'info' } : { text, icon: 'info', action: { label: 'See changes', run } })
    for (const m of merged) if (m.copy === undefined) noteBoardSaved(root, vaultPath(root, m.path))
  }, [merged, root])

  /**
   * ⌘C / ⌘X / ⌘V for the sidebar's FILE clipboard (D6 amended, YAZ-1674). A WINDOW listener: a
   * panel listener needs focus inside the panel, and after a click on the open file focus sits in
   * the canvas (YAZ-961's handoff) while blank space is not focusable at all. `ownsWindowChord`
   * draws the boundary — a text field, the canvas or a modal keeps the key, so text copy/paste is
   * untouched. The RULES are the Sidebar's — target, order, the clipboard gate — behind a handle
   * it fills and empties; this only asks, and swallows the key exactly when a verb says it acted.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const verb = fileClipboardVerb(event)
      if (verb === null) return
      const clipboard = sidebarClipboard.current
      if (clipboard === null) return
      const acted = verb === 'paste' ? clipboard.paste() : clipboard.cutOrCopy(verb)
      if (!acted) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // In-app rename (Links E1 GRO-2194, folders E1b GRO-2241). `file:renamed` reaches EVERY
  // window (originator included): BEFORE the workspace remap unmounts the old-path editor(s),
  // the old controller is retired so nothing can flush to the old path (see
  // lib/renameContinuity.ts); then its tab follows in place, and title/URL-hash track the
  // active tab through the existing effects above. A `dir` event is a PREFIX remap: every open
  // editor and workspace path under the folder follows, and a window ROOTED at (or under) the
  // folder — a subfolder opened as a vault — follows too (main's store repair already moved
  // its WindowEntry.root; setRoot only mirrors it locally, so no identity write that could
  // clobber the repaired file/tabs).
  useEffect(
    () =>
      api.file.onRenamed(({ oldPath, newPath, kind }) => {
        // A shared board's pending live-link upload follows it (YAZ-1886); by prefix, so both kinds.
        noteBoardRenamed(oldPath, newPath)
        if (kind === 'dir') {
          retireDir(oldPath)
          const movedRoot = root !== null && isWithin(oldPath, root) ? newPath + root.slice(oldPath.length) : undefined
          renameWorkspaceDir(oldPath, newPath, movedRoot)
          if (movedRoot !== undefined) setRoot(movedRoot)
          return
        }
        retirePath(oldPath)
        renameWorkspacePath(oldPath, newPath)
      }),
    [renameWorkspacePath, renameWorkspaceDir, root],
  )

  /**
   * THE ONE RENAME DOOR (files E1, folders + drag-moves E1b). Every rename gesture in the app —
   * the sidebar's inline rename, its drag-move — arrives here as (oldPath, newPath), so the
   * behaviour is written once. Flush our own buffer(s) for the file — or every open editor under
   * the folder — then rename; the commit is the Enter, with no confirm in between (🔒 YAZ-1775:
   * the sheet was deleted once wikilinks were gone — it warned about nothing. Delete and move
   * keep their confirms). All failures land in the passive notice — never a dialog, never a
   * rejection back into the inline input.
   */
  const renameFile = useCallback(
    async (oldPath: string, newPath: string): Promise<void> => {
      if (root === null) return
      // Our own unsaved buffers travel WITH the file(s). The kind is unknown until the rename
      // answers, so both run — each is a no-op for the other kind.
      await flushRenamedPath(oldPath)
      await flushRenamedDir(oldPath)
      try {
        await api.file.rename({ oldPath, newPath })
      } catch (err) {
        const exists = err instanceof BridgeRequestError && err.code === 'ALREADY_EXISTS'
        notify(exists ? `Can't rename: "${basename(newPath)}" already exists` : `Can't rename: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [root, notify],
  )

  /**
   * In-app delete landed (GRO-2272). Reaches EVERY window, originator included.
   *
   * ORDER IS NOT NEGOTIABLE: retire the editor, THEN remap the workspace. Removing a tab
   * unmounts its editor, and `DrawingEditor`'s unmount cleanup flushes the live scene to disk
   * — which would recreate the file that was just trashed. Retiring first makes that flush a
   * no-op. Reverse these two lines and the delete silently fails a second later.
   *
   * A window ROOTED at (or under) a deleted folder is deliberately not repaired here: the
   * sidebar's existing `onRootMissing` probe owns that, and it also drops the dead MRU entry.
   */
  useEffect(
    () =>
      api.file.onDeleted(({ path, kind }) => {
        if (kind === 'dir') {
          retireDir(path)
          deleteWorkspaceDir(path)
          return
        }
        retirePath(path)
        deleteWorkspacePath(path)
      }),
    [deleteWorkspacePath, deleteWorkspaceDir],
  )

  /**
   * The sidebar's Delete commit (GRO-2272). Deliberately NOT the mirror of `renameFile`, and
   * the omission is load-bearing: NO pre-delete flush. `renameFile` flushes so the unsaved buffer
   * travels with the file; a delete has nowhere to travel to, so flushing would write the file to
   * disk moments before trashing it — pointless at best, racy at worst.
   *
   * Every failure lands in the passive notice, never a dialog; this promise never rejects back
   * into the caller, matching `onRenameFile`.
   */
  const deleteFile = useCallback(async (path: string): Promise<void> => {
    try {
      await api.file.delete({ path })
    } catch (err) {
      const name = basename(path)
      // A failed trash means NOTHING was deleted — say so, rather than a bare error string.
      notify(
        err instanceof BridgeRequestError && err.code === 'IO_ERROR'
          ? `Can't move "${name}" to the Trash — nothing was deleted`
          : `Can't delete "${name}": ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }, [notify])

  const onRootMissing = useCallback(() => {
    storage.setRoot(null) // one identity write: { root: null, file: null, tabs: [] }
    setSidebarRevealRequest(null)
    setRoot(null)
    resetTabs(null, null)
  }, [resetTabs])
  // The ACTIVE file vanished on disk: close its tab, ⌘W-style (a neighbour takes over).
  const onFileMissing = useCallback(() => void closeActive(), [closeActive])

  return (
    <div className="app">
      {notice !== null && (
        // `data-icon` is a test / observability hook — nothing in the CSS selects it; the glyph is the SVG.
        <div className={`link-notice${notice.action === undefined ? '' : ' link-notice--action'}`} role="status" data-icon={notice.icon}>
          <NoticeIcon icon={notice.icon} />
          <span className="link-notice__text">{notice.text}</span>
          {notice.action !== undefined && (
            <>
              <button
                type="button"
                className="link-notice__action"
                onClick={() => {
                  notice.action?.run()
                  setNotice(null)
                }}
              >
                {notice.action.label}
              </button>
              <button type="button" className="link-notice__close" aria-label="Dismiss" onClick={() => setNotice(null)}>
                ✕
              </button>
            </>
          )}
        </div>
      )}
      {/* YAZ-1679: unmounted when closed, never hidden. ONE useGithubSync per window (above): the
          dialog's Sync page and the editor's chip read the same status, so they can never
          disagree about what this vault is doing. */}
      {settingsOpen && (
        <SettingsDialog
          ctx={{ settings, onChange: changeSettings, sync: { status: githubSync.status, setEnabled: githubSync.setEnabled }, storage: root === null ? undefined : vaultStorage, sharing }}
          onClose={closeSettings}
          initialPage={settingsPage}
        />
      )}
      {sharePath !== null && root !== null && <ShareDialog key={sharePath} root={root} path={sharePath} onClose={() => setSharePath(null)} onOpenSettings={openSharingSettings} />}
      {history !== null && root !== null && <VersionHistory key={history.path} root={root} path={history.path} fromMerge={history.fromMerge} darkColors={settings.diagramDarkColors} onClose={() => setHistory(null)} onNotice={notify} />}
      {/* YAZ-1818: sync needs attention. Two of the six reasons are things this app cannot fix from
          inside itself (git missing, credentials rejected), so the offer is a prompt to paste
          into any LLM — an assistant that CAN drive the terminal — rather than a wizard. */}
      {syncCopy !== null && !syncDismissed && root !== null && githubSync.status !== null && (
        <div className="sync-banner" role="status">
          <span className="sync-banner__text">
            <strong>{syncCopy.title}</strong> {syncCopy.body}
          </span>
          {syncCopy.showSetupPrompt && (
            <button type="button" onClick={() => void navigator.clipboard.writeText(buildSetupPrompt(root, githubSync.status?.attention ?? 'error'))}>
              Copy setup prompt
            </button>
          )}
          {/* YAZ-1801 D3: a file that is not backed up is not a banner to wave away — `too-large` has
              no Dismiss and stays until a pass stops finding it. */}
          {syncCopy.dismissible && (
            <button type="button" onClick={() => setSyncDismissed(true)}>
              Dismiss
            </button>
          )}
        </div>
      )}
      {root !== null && !sidebarCollapsed && (
        <Sidebar
          key={root}
          root={root}
          activeFile={file}
          watch={watch}
          onOpenFile={openCurrent}
          onOpenFileBackground={openBackground}
          onRevealInFiles={revealInFiles}
          onPickFolder={pick}
          pickDisabled={picking}
          onCollapse={toggleSidebar}
          // The lens tabs (YAZ-847): App owns the value, the sidebar only renders the row.
          lens={sidebarLens}
          revealRequest={sidebarRevealRequest}
          onRevealConsumed={consumeSidebarReveal}
          onLensChange={changeLens}
          settings={settings}
          onChangeSettings={changeSettings}
          onOpenSettings={openSettings}
          onRootMissing={onRootMissing}
          onFileMissing={onFileMissing}
          onRenameFile={renameFile}
          onDeleteFile={deleteFile}
          onShareFile={setSharePath}
          onHistoryFile={openHistory}
          onNotice={notify}
          // YAZ-1801 D3: rows over GitHub's limit wear a cloud-off icon — from the one sync status above.
          tooLarge={tooLargePaths}
          // ⌘C / ⌘X / ⌘V's handle (D6 amended, YAZ-1674): the panel fills it, the listener above asks it.
          clipboardRef={sidebarClipboard}
          pendingSearchFocus={pendingSearchFocus}
          onSearchFocusHandled={searchFocusHandled}
          // ⌘O (YAZ-1767 D8): only a request made on THIS root counts; any other reads as none.
          switcherOpenRequest={switcherRequest.root === root ? switcherRequest.seq : 0}
          // The in-place switch: the vault menu's "Open in this window" (YAZ-1941 D2) and the switcher's ⇧⏎ / ⇧-click (Docs YAZ-1974 D8).
          onOpenVaultHere={openRoot}
        />
      )}
      {root !== null && !sidebarCollapsed && <div className={`sidebar-resize${resizing ? ' sidebar-resize--active' : ''}`} aria-hidden onMouseDown={startSidebarResize} />}
      {root === null ? (
        <section className="editor">
          {/* No dialog opens by itself (C2, GRO-2164): the Welcome screen offers recents + Open folder…. */}
          <Welcome recents={storage.getRecentRoots()} onOpenRecent={openRoot} onPickFolder={pick} picking={picking} />
        </section>
      ) : (
        <div className="workspace">
          {/* Tabs rule 2: the strip shows whenever a folder is open — even with one (or zero) tabs. */}
          <TabBar
            tabs={tabs}
            active={file}
            onActivate={activate}
            onClose={closeTab}
            onMove={moveTab}
            canBack={canBack}
            canForward={canForward}
            onBack={back}
            onForward={forward}
            onShowSidebar={sidebarCollapsed ? toggleSidebar : undefined}
            onShowInSidebar={showInSidebar}
            onNotice={notify}
          />
          <div className="tabstack">
            {mounted.length === 0 && <Editor path={null} root={root} watch={watch} diagramDarkColors={settings.diagramDarkColors} />}
            {mounted.map((path) => (
              // Every VISITED tab keeps its document mounted so its view state survives a switch
              // (rule 6); inactive layers hide via visibility — see tabs.css for why
              // display:none would lose scroll positions.
              <div key={path} className={path === file ? 'tabstack__layer' : 'tabstack__layer tabstack__layer--hidden'}>
                {/* One sync status per WINDOW (above), read by every mounted tab's chip: two
                    hooks watching one root would eventually disagree about what it is doing. */}
                <Editor
                  path={path}
                  root={root}
                  watch={watch}
                  sync={githubSync.status}
                  onSyncNow={githubSync.syncNow}
                  canvasPrefs={settings.canvas}
                  onCanvasPrefsChange={changeCanvasPrefs}
                  canvasPanel={settings.canvasPanel}
                  onCanvasPanelChange={changeCanvasPanel}
                  diagramDarkColors={settings.diagramDarkColors}
                  onNotice={notify}
                  onToggleSidebar={toggleSidebar}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
