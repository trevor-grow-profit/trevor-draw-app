/**
 * The sidebar header's vault switcher (YAZ-1767): GitHub Desktop's repository panel, keyboard-first.
 * The header's top-left button is the trigger — bold vault name plus a small chevron (D6) — and the
 * panel it drops is a `ContextMenuSurface` hung off the header's own rect (D5), flush with the
 * sidebar and at least as wide — wider when a name needs it, so no name is ever cut (Docs YAZ-1974 D7).
 * Its first element is the filter input, autofocused, query reset on every open (D7);
 * below it every recent vault as ONE line — name, then relative time (Docs YAZ-1974 D2) — the CURRENT
 * vault included and marked `aria-current` (D3); and LAST, under a hairline, "Open folder…" — the
 * app's folder picker (D4), which opens the picked vault beside this window, never in place
 * (YAZ-1913 🔒 D2). Two vaults can share a name, so the full path is one hover away:
 * a row's ⓘ, shown while the row is hovered, draws the WHOLE path wrapped at its slashes in a
 * tooltip portalled to <body> — the panel's scroll box never clips it. Mouse-only, by design.
 *
 * ONE rule for every vault row (D1/D3): activating it — click or ⏎ — asks main's one open-recent
 * door, `window.openRecent(path)`, which brings that vault to the front: its open windows raised
 * (D9) or, with none, a NEW window on its remembered last file (D2) — and bumps the MRU either
 * way; the current vault's row simply raises this window. A folder that is gone answers `false`:
 * the row is disabled with "Folder not found" in the time slot and the panel STAYS open
 * (Welcome's behaviour), so the next choice is one keystroke away. `true` closes the panel.
 *
 * Names (YAZ-2056, a port of Docs YAZ-1974 D4): the trigger and every row show the vault's display
 * name (`storage.vaultName`, the folder name when none is set). The filter matches the display name
 * AND the folder name (Docs YAZ-1974 D6) — one row per vault, at its better rank.
 *
 * The keyboard model (D7): ranking is `matchCandidates` over those names (exact, then prefix,
 * then substring; an empty query is MRU order). One highlighted row;
 * with an EMPTY query it starts on the first row that is NOT the current vault — so ⌘O ⏎ jumps to
 * the last-used OTHER vault, like ⌘Tab — with a typed query on the top match, and with no match on
 * Open folder…. ↑/↓ clamp at both ends (Docs' `[[` picker's no-wrap rule), hover moves it too, ⏎
 * activates it — ⇧⏎ / ⇧-click open it IN this window instead, the menu's verb (Docs YAZ-1974 D8), and
 * while ⇧ is held the highlighted row says so: "Open here" in its time slot (D9) — Esc
 * closes (the menu convention — not the search bar's two-press rule). Typing never leaves the input:
 * rows swallow their own mousedown. "Open folder…" is not a candidate, so it is visible whatever
 * the query; a query with no vault match shows "No matching vaults" above it.
 *
 * ⌘O (D8): App bumps `openRequest`; each new value toggles the panel — opens it with the filter focused, or closes it.
 * Rows are read fresh from `storage.getRecentRoots()` on every open, never cached across opens.
 *
 * Right-click (YAZ-1941, a port of Docs YAZ-1798 — the D-numbers below are 1798's): the trigger
 * (= the current vault) and every live row open the vault menu — `buildVaultMenuSections` drawn by
 * the sidebar's own `ContextMenu`. "Open in this window" (D8/D11) — or ⇧⏎ / ⇧-click on a row
 * (Docs YAZ-1974 D8) — is the deliberate in-place switch; a `false` from it greys the row exactly
 * like a click's. The menu is the top layer
 * while it stands (D4): Esc and click-away close it alone, and the filter ignores ↑/↓/⏎/Esc until
 * it is gone. Right-click never moves the highlight.
 *
 * "Set display name" (Docs YAZ-1974 D5) turns the name into an inline field where it was right-clicked —
 * the header or the row, a `<div>` in place of the `<button>` meanwhile. ⏎ or blur saves, Esc
 * cancels, an empty field is the folder name again; the field is the top layer while it stands:
 * Esc and click-away end it alone, and a click on another row only ends it, never opens a vault.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { ContextMenuSurface } from '../components/ContextMenuSurface'
import { matchCandidates } from '../search/matchCandidates'
import { basename } from '../lib/paths'
import { relativeTime } from '../lib/relativeTime'
import { storage } from '../lib/storage'
import { InfoIcon, TriangleIcon } from '../components/icons'
import { TextField } from '../components/TextField'
import { useVaultName } from '../lib/useVaultName'
import { ContextMenu } from './ContextMenu'
import { buildVaultMenuSections } from './vaultMenuSections'
import { api } from '../api'

export interface VaultSwitcherProps {
  root: string
  /** "Open folder…" (D4): App's folder picker — the picked vault opens beside this window (YAZ-1913). */
  onPickFolder: () => void
  /** True while the native folder dialog is open; the "Open folder…" row is disabled meanwhile. */
  pickDisabled: boolean
  /** ⌘O (D8): a counter App bumps per request; 0 = nothing requested. Each new value TOGGLES the panel — open with the filter focused, or close. */
  openRequest: number
  /** The menu's "Open in this window" (YAZ-1798 D8) and a row's ⇧⏎ / ⇧-click (Docs YAZ-1974 D8): App's in-place switch; `false` = the folder is gone (MRU already pruned). */
  onOpenHere: (path: string) => Promise<boolean>
  /** The menu's OS verbs (D9): the Sidebar's own, stale-path notice included. */
  onReveal: (path: string) => void
  onOpenVsCode: (path: string) => void
  /** The Sidebar's passive notice — the copies confirm through it (D9). */
  onNotice: (message: string) => void
}

/** One recent vault as the panel ranks and draws it: `name` is its display name, `folder` its basename — the filter matches both (Docs YAZ-1974 D6). */
export interface VaultRow {
  name: string
  folder: string
  path: string
  lastOpened: number
}

/** Where a vault's name stands — and so where "Set display name" turns it into a field (Docs YAZ-1974 D5). */
type RenameAt = 'header' | 'row'

interface PanelState {
  rows: VaultRow[]
  /** Captured once per open, so every row's relative time is measured against the same instant. */
  now: number
  anchor: { x: number; y: number; width: number }
}

export const NO_MATCH_TEXT = 'No matching vaults'
export const MISSING_TEXT = 'Folder not found'
export const OPEN_FOLDER_TEXT = 'Open folder…'
/** The highlighted row's time slot while ⇧ is held (Docs YAZ-1974 D9): what ⇧⏎ / ⇧-click will do. */
export const OPEN_HERE_TEXT = 'Open here'

/**
 * The rows `query` keeps, ranked (D7): an empty query is MRU order untouched; otherwise the app's
 * one ranking, uncapped, over one candidate per name a row answers to — its display name and,
 * when it differs, its folder name (Docs YAZ-1974 D6, Docs' `[[` picker's alias idea) — each row once, at its best rank.
 */
export function rankVaultRows(rows: readonly VaultRow[], query: string): VaultRow[] {
  if (query.trim() === '') return [...rows]
  const candidates = rows.flatMap((row) => (row.folder === row.name ? [{ name: row.name, row }] : [{ name: row.name, row }, { name: row.folder, row }]))
  return [...new Set(matchCandidates(candidates, query, candidates.length).map((c) => c.row))]
}

/**
 * Where the highlight starts (D7). The index is over `[...matches, Open folder…]`, so with no
 * match at all it lands on the Open folder… row (= `matches.length`).
 */
export function defaultHighlight(matches: readonly { path: string }[], query: string, root: string): number {
  if (query.trim() !== '') return 0
  const other = matches.findIndex((m) => m.path !== root)
  return other === -1 ? 0 : other
}

export function VaultSwitcher({ root, onPickFolder, pickDisabled, openRequest, onOpenHere, onReveal, onOpenVsCode, onNotice }: VaultSwitcherProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  /** The header's name slot — the trigger, or its rename field (Docs YAZ-1974 D5) — so the panel finds its anchor either way. */
  const slotRef = useRef<HTMLElement | null>(null)
  const setSlot = useCallback((el: HTMLElement | null) => {
    slotRef.current = el
  }, [])
  const [panel, setPanel] = useState<PanelState | null>(null)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set())
  /** The right-click menu (YAZ-1798), pinned to the vault it was opened on — and where: its rename happens there (Docs YAZ-1974 D5). */
  const [vaultMenu, setVaultMenu] = useState<{ path: string; at: RenameAt; x: number; y: number } | null>(null)
  /** The name currently an inline field (Docs YAZ-1974 D5): the header's, or a row's. */
  const [renaming, setRenaming] = useState<{ path: string; at: RenameAt } | null>(null)
  /** The ⓘ tooltip (Docs YAZ-1974 D2): the hovered row's path and rect, while the pointer is on its ⓘ. */
  const [pathTip, setPathTip] = useState<{ path: string; rect: DOMRect } | null>(null)
  /** Set by a row's mousedown mid-rename, so the click it starts only ends the rename (D5). */
  const dropClick = useRef(false)
  /** ⇧ held while the panel is up (Docs YAZ-1974 D9) — tracked on window so the cue shows before any ⏎ or click. */
  const [shiftHeld, setShiftHeld] = useState(false)
  const name = useVaultName(root)
  const open = panel !== null

  const openPanel = useCallback(() => {
    // Anchor = the `.sidebar__header` rect (the name slot's parent): the panel hangs off the whole header, flush with the sidebar (D5).
    const rect = slotRef.current?.parentElement?.getBoundingClientRect()
    const rows = storage.getRecentRoots().map((r) => ({ name: storage.vaultName(r.path), folder: basename(r.path), path: r.path, lastOpened: r.lastOpened }))
    setPanel({ rows, now: Date.now(), anchor: rect === undefined ? { x: 0, y: 0, width: 280 } : { x: rect.left, y: rect.bottom, width: rect.width } })
    setQuery('')
    setMissing(new Set())
  }, [])
  // A row's rename field and the ⓘ tooltip go with the panel (a field that unmounts is a cancel); the header's stays.
  const closePanel = useCallback(() => {
    setPanel(null)
    setRenaming((r) => (r?.at === 'row' ? null : r))
    setPathTip(null)
  }, [])
  const closeVaultMenu = useCallback(() => setVaultMenu(null), [])

  // The filter takes focus whenever the panel mounts (D7).
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const sync = (e: globalThis.KeyboardEvent) => setShiftHeld(e.shiftKey)
    const release = () => setShiftHeld(false)
    window.addEventListener('keydown', sync)
    window.addEventListener('keyup', sync)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('keydown', sync)
      window.removeEventListener('keyup', sync)
      window.removeEventListener('blur', release)
      setShiftHeld(false)
    }
  }, [open])

  // ⌘O (D8) TOGGLES: each new request value opens the panel with a fresh query, or closes it when
  // it is already up — so ⌘O ⌘O is a no-op round trip, the way ⌘K's search bar answers a second press.
  // `openRef` mirrors `open` so this effect runs on the REQUEST alone, never on the open/close itself.
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    if (openRequest === 0) return
    if (openRef.current) {
      closePanel()
      return
    }
    openPanel()
    inputRef.current?.focus()
  }, [openRequest, openPanel, closePanel])

  const matches = useMemo(() => (panel === null ? [] : rankVaultRows(panel.rows, query)), [panel, query])
  /** The Open folder… row's index in the highlight space. */
  const openFolderIndex = matches.length

  // The highlight re-seeds exactly when `matches` does — on open and on every keystroke (D7).
  useEffect(() => {
    setActive(defaultHighlight(matches, query, root))
  }, [matches, query, root])

  /**
   * One rule for every way a row opens — a click or ⏎ (beside, `openRecent`), ⇧⏎ / ⇧-click (in
   * place, Docs YAZ-1974 D8) and the menu's "Open in this window" (in place, D8): `true` closes the
   * panel; `false` or a rejection greys the row with "Folder not found" and keeps the panel up, the
   * filter focused (D5).
   */
  const settle = (path: string, opening: Promise<boolean>, what: string): void => {
    void opening
      .catch((err: unknown) => {
        console.error(`[vault-switcher] ${what} failed:`, err)
        return false
      })
      .then((opened) => {
        if (opened) {
          closePanel()
          return
        }
        setMissing((prev) => new Set(prev).add(path))
        inputRef.current?.focus()
      })
  }
  const choose = (path: string): void => settle(path, api.window.openRecent(path), 'openRecent')

  /** Remove from recent vaults (D3): forgets the MRU entry only — the folder is untouched — and the row leaves at once. */
  const removeRow = (path: string): void => {
    storage.removeRecentRoot(path)
    setPanel((p) => (p === null ? p : { ...p, rows: p.rows.filter((r) => r.path !== path) }))
    inputRef.current?.focus()
  }

  /** Save a display name (Docs YAZ-1974 D5) — `null` is Reset to folder name — and redraw the open panel's row with it, `removeRow`'s idiom. */
  const saveName = (path: string, raw: string | null): void => {
    storage.setVaultName(path, raw)
    const next = storage.vaultName(path)
    setPanel((p) => (p === null ? p : { ...p, rows: p.rows.map((r) => (r.path === path ? { ...r, name: next } : r)) }))
    inputRef.current?.focus()
  }
  const endRename = (): void => {
    setRenaming(null)
    inputRef.current?.focus()
  }
  /** The inline field (D5): the display name selected, the folder name as placeholder; ⏎ / blur save, Esc cancels, empty = the folder name. */
  const nameField = (path: string, value: string) => (
    <TextField
      className="vault-switcher__rename"
      value={value}
      placeholder={basename(path)}
      aria-label="Display name"
      autoFocus
      selectOnMount
      normalize={(draft) => draft.trim()}
      onCommit={(next) => saveName(path, next)}
      onDone={endRename}
    />
  )

  /** The vault menu's target (Docs YAZ-1974 D4/D5): what the app calls it, and whether that is a display name at all. */
  const menuTarget = (path: string) => {
    const display = storage.vaultName(path)
    return { path, name: display, isCurrent: path === root, renamed: display !== basename(path) }
  }

  /** Right-click (D1): ALWAYS swallow the native text menu (G1); a dead row gets no vault menu — its MRU entry is already gone. */
  const openVaultMenu = (path: string, at: RenameAt, e: MouseEvent): void => {
    e.preventDefault()
    if (missing.has(path)) return
    setPathTip(null)
    setVaultMenu({ path, at, x: e.clientX, y: e.clientY })
  }

  /**
   * Rows swallow their mousedown so typing never leaves the filter (D7). Mid-rename (Docs YAZ-1974 D5)
   * it ends the rename instead — the filter takes focus, the field's blur saves — and the click it
   * starts is dropped, so a vault never opens by accident.
   */
  const rowMouseDown = (e: MouseEvent): void => {
    e.preventDefault()
    dropClick.current = renaming !== null
    if (dropClick.current) inputRef.current?.focus()
  }

  /** `here` = ⇧ held (Docs YAZ-1974 D8): "Open in this window" instead of beside; on the current vault it is a plain ⏎. */
  const activate = (index: number, here = false): void => {
    if (index === openFolderIndex) {
      if (pickDisabled) return
      closePanel()
      onPickFolder()
      return
    }
    const row = matches[index]
    if (row === undefined || missing.has(row.path)) return
    if (here && row.path !== root) settle(row.path, onOpenHere(row.path), 'openHere')
    else choose(row.path)
  }
  const clickRow = (index: number, e: MouseEvent): void => {
    if (!dropClick.current) activate(index, e.shiftKey)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    // The menu is the top layer (D4): its own window listener takes Esc; nothing else reaches the panel.
    if (vaultMenu !== null) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setActive((i) => Math.min(openFolderIndex, i + 1))
        return
      case 'ArrowUp':
        e.preventDefault()
        setActive((i) => Math.max(0, i - 1))
        return
      case 'Enter':
        e.preventDefault()
        activate(active, e.shiftKey)
        return
      case 'Escape':
        e.preventDefault()
        closePanel()
        return
      default:
        return
    }
  }

  return (
    <>
      {renaming?.at === 'header' ? (
        <div ref={setSlot} className="sidebar__root">
          {nameField(root, name)}
        </div>
      ) : (
        // stopPropagation on mousedown: the surface closes on any window mousedown, so without it a
        // second click on the trigger would close and immediately reopen the panel.
        <button
          ref={setSlot}
          type="button"
          className="sidebar__root"
          title={root}
          aria-haspopup="menu"
          aria-expanded={open}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => (open ? closePanel() : openPanel())}
          onContextMenu={(e) => openVaultMenu(root, 'header', e)}
        >
          <span className="sidebar__root-name">{name}</span>
          <span className="sidebar__root-hint" aria-hidden="true"><TriangleIcon up={open} /></span>
        </button>
      )}
      {panel !== null && (
        // The top layer closes alone (D4): the vault menu first; a rename field ends on its own blur, so click-away keeps the panel.
        <ContextMenuSurface x={panel.anchor.x} y={panel.anchor.y} minWidth={panel.anchor.width} className="ctx-menu--panel" onClose={vaultMenu !== null ? closeVaultMenu : renaming !== null ? () => undefined : closePanel}>
          <div className="vault-switcher" onWheel={() => setPathTip(null)}>
            <input
              ref={inputRef}
              className="vault-switcher__filter"
              type="text"
              placeholder="Switch vault…"
              aria-label="Switch vault"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <div className="vault-switcher__rows">
              {matches.length === 0 && <div className="vault-switcher__empty">{NO_MATCH_TEXT}</div>}
              {matches.map((row, i) => {
                const gone = missing.has(row.path)
                const here = shiftHeld && i === active && row.path !== root && !gone
                const when = (
                  <span className={`vault-switcher__when${gone ? ' vault-switcher__when--missing' : here ? ' vault-switcher__when--here' : ''}`}>
                    {gone ? MISSING_TEXT : here ? OPEN_HERE_TEXT : relativeTime(row.lastOpened, panel.now)}
                  </span>
                )
                if (renaming?.at === 'row' && renaming.path === row.path) {
                  return (
                    <div key={row.path} className="vault-switcher__row vault-switcher__row--renaming">
                      {nameField(row.path, row.name)}
                      {when}
                    </div>
                  )
                }
                return (
                  <button
                    key={row.path}
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className={`vault-switcher__row${i === active ? ' vault-switcher__row--active' : ''}`}
                    aria-current={row.path === root ? 'true' : undefined}
                    disabled={gone}
                    onMouseDown={rowMouseDown}
                    onMouseEnter={() => setActive(i)}
                    onClick={(e) => clickRow(i, e)}
                    onContextMenu={(e) => openVaultMenu(row.path, 'row', e)}
                  >
                    <span className="vault-switcher__name">{row.name}</span>
                    {/* Part of its row (D2): a click is the row's click, a right-click the row's menu. */}
                    <span
                      className="vault-switcher__info"
                      aria-hidden="true"
                      onMouseEnter={(e) => setPathTip({ path: row.path, rect: e.currentTarget.parentElement!.getBoundingClientRect() })}
                      onMouseLeave={() => setPathTip(null)}
                    >
                      <InfoIcon />
                    </span>
                    {when}
                  </button>
                )
              })}
            </div>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`vault-switcher__row vault-switcher__open${active === openFolderIndex ? ' vault-switcher__row--active' : ''}`}
              disabled={pickDisabled}
              onMouseDown={rowMouseDown}
              onMouseEnter={() => setActive(openFolderIndex)}
              onClick={(e) => clickRow(openFolderIndex, e)}
            >
              {OPEN_FOLDER_TEXT}
            </button>
          </div>
        </ContextMenuSurface>
      )}
      {pathTip !== null &&
        createPortal(
          // Under the row, or above it when there is more room there (the last rows); `<wbr>` after every `/` is where the WHOLE path wraps (D2).
          <div
            className="vault-switcher__tip"
            role="tooltip"
            style={{
              left: pathTip.rect.left,
              width: pathTip.rect.width,
              ...(window.innerHeight - pathTip.rect.bottom >= pathTip.rect.top ? { top: pathTip.rect.bottom } : { bottom: window.innerHeight - pathTip.rect.top }),
            }}
          >
            {pathTip.path.split(/(?<=\/)/).map((part, i) => (
              <Fragment key={i}>
                {part}
                <wbr />
              </Fragment>
            ))}
          </div>,
          document.body,
        )}
      {vaultMenu !== null && (
        <ContextMenu
          x={vaultMenu.x}
          y={vaultMenu.y}
          sections={buildVaultMenuSections(
            menuTarget(vaultMenu.path),
            {
              onOpenHere: (path) => settle(path, onOpenHere(path), 'openHere'),
              onRename: (path) => setRenaming({ path, at: vaultMenu.at }),
              onResetName: (path) => saveName(path, null),
              onReveal,
              onOpenVsCode,
              onRemove: removeRow,
              onNotice,
            },
          )}
          onClose={closeVaultMenu}
        />
      )}
    </>
  )
}
