/**
 * THE COMPONENTS TAB (🔒 YAZ-1775 D5, YAZ-1819): save the selection as a named component, search
 * the library, insert independent copies, rename and delete. `docs/CONTRACTS.md` § Components is
 * the normative description of the doors and the on-disk shape; this file states only what the
 * PANEL decides.
 *
 * The whole library is a folder of small files, so it is listed once and searched IN THE RENDERER
 * through the app's one matcher (`search/matchCandidates.ts`) — never a second ranking. The
 * `components:changed` push re-lists it, which is what makes one library out of every vault.
 *
 * NO NATIVE DIALOGS. The rename is a field in the card and the delete is a confirm row in it, and
 * 🔒 `confirmDelete` (Settings › Files) decides whether that row appears at all.
 *
 * WHAT AN INSERT COSTS ON DISK: the component's images become `assets/` files in THIS vault the
 * first time the board is saved after it (🔒 YAZ-1775 D3) — see `componentData.ts`.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ComponentItem } from '@shared/types'
import { api } from '../api'
import { loadExcalidrawElement } from '../drawings/engine'
import { storage } from '../lib/storage'
import { matchCandidates } from '../search/matchCandidates'
import {
  captureComponentSelection,
  componentFragmentJson,
  insertComponent,
  type CapturedComponent,
  type ComponentElementApi,
  type ComponentEngine,
  type ComponentTarget,
} from './componentData'
import { createPreviewCache } from '../lib/previewCache'
import { createStore } from '../lib/store'
import { createScenePreviewPng, type PreviewEngine } from '../lib/scenePreview'
import { importedComponentName, parseImportedComponentJson } from './componentImport'
import './savedComponents.css'

/** The page the grid grows by — the web app's own `PAGE_SIZE`. */
export const PAGE_SIZE = 24

/** What the tab says when the library is empty, and when a search matches nothing. */
export const EMPTY_LIBRARY = 'No saved components yet'
const NOTHING_SELECTED = 'Select something on the canvas to save it as a component.'
/** What a file that is not an importable component says — passively, because nothing was written. */
export const IMPORT_FAILED = 'That file could not be imported as a component.'

export interface SavedComponentsProps {
  /** The engine values a capture, an insert and a preview need; the tab only exists once it loaded. */
  engine: ComponentEngine & PreviewEngine
  /** The engine's imperative handle; `CanvasSidebar` does not render a tab without one. */
  excalidrawAPI: ComponentTarget
  /** Whether the canvas holds a selection right now — the web app's `useUIAppState()`, hoisted to the surface. */
  hasSelection: boolean
}

const getErrorMessage = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback)

/**
 * The card pictures, keyed by SLUG — a component's identity. Cleared whenever the library itself
 * changes, because a slug that came back means different bytes. Bounded like Image Studio's tiles
 * (YAZ-2073 8B): scrolling a large library must not keep every picture it ever showed.
 */
const previews = createPreviewCache(async (slug) => api.components.preview({ slug }), { limit: 300 })
export const clearComponentPreviewMemo = previews.clear

/**
 * The tab's session (🔒 YAZ-1990 D5): closing the canvas panel UNMOUNTS the tab, so the list, the
 * query, the rows shown and the scroll live here — one per window, empty after an app restart.
 * The list is still re-listed on every mount; keeping it is what lets the scroll land on reopen.
 */
const session = createStore({ items: [] as ComponentItem[], query: '', shown: PAGE_SIZE })
let scrollTop = 0
/** `useState`'s setter shape, so every call site that edits the list reads as it did. */
const setItems = (next: ComponentItem[] | ((current: ComponentItem[]) => ComponentItem[])) =>
  session.set({ items: typeof next === 'function' ? next(session.getState().items) : next })

/** A test starts from an empty tab. */
export function resetComponentsSession() {
  scrollTop = 0
  session.set({ items: [], query: '', shown: PAGE_SIZE })
}

export function SavedComponents({ engine, excalidrawAPI, hasSelection }: SavedComponentsProps) {
  const { items, query, shown } = useSyncExternalStore(session.subscribe, session.getState)
  const contentRef = useRef<HTMLDivElement>(null)
  // Back where the list was left; the rows come from the session, so they exist on the first paint.
  useLayoutEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = scrollTop
  }, [])
  const [element, setElement] = useState<ComponentElementApi | null>(null)
  const [captured, setCaptured] = useState<CapturedComponent | null>(null)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [busySlug, setBusySlug] = useState<string | null>(null)
  const [openMenuSlug, setOpenMenuSlug] = useState<string | null>(null)
  const [renamingSlug, setRenamingSlug] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [confirmingSlug, setConfirmingSlug] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(() => storage.getSettings().confirmDelete)
  const [error, setError] = useState<string | null>(null)
  /** The import's own line: PASSIVE, because a refused import changed nothing (YAZ-1833). */
  const [notice, setNotice] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)

  // The library, and the ONE push that keeps it true in every window and every vault (🔒 YAZ-1775 D5).
  useEffect(() => {
    let live = true
    const refresh = () => {
      void api.components.list().then(
        (list) => live && setItems(list),
        (cause: unknown) => live && setError(getErrorMessage(cause, 'Components could not be loaded.')),
      )
    }
    refresh()
    const off = api.components.onChanged(() => {
      // A slug that came back means different bytes; the pictures are re-asked for.
      previews.clear()
      refresh()
    })
    return () => {
      live = false
      off()
    }
  }, [])

  // 🔒 `confirmDelete` (Settings › Files) decides whether a delete asks first. Read off the
  // renderer's own state cache rather than threaded through four components that do not care —
  // the same seam `App` reads it from, so a change in any window reaches this tab too.
  useEffect(() => storage.subscribe(() => setConfirmDelete(storage.getSettings().confirmDelete)), [])

  // The element package, lazily (YAZ-1818's second package): only a CAPTURE needs it, so the tab
  // lists, searches and inserts while it is still on its way.
  useEffect(() => {
    let live = true
    void loadExcalidrawElement().then(
      (mod) => live && setElement(mod as ComponentElementApi),
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [])

  // The element package is the only thing a capture can still be waiting on (YAZ-1818's second download).
  const canSaveSelection = hasSelection && element !== null && captured === null

  /** The ⌘K matcher over the component NAMES; an empty query keeps the library's own order. */
  const matched = useMemo(() => matchCandidates(items.map((item) => ({ ...item, lower: item.name.toLowerCase() })), query, items.length), [items, query])
  const visible = matched.slice(0, shown)
  const canLoadMore = matched.length > shown

  // The Images tab's paging gesture, so one panel does not have two: a sentinel at the end of the
  // grid grows the page as it comes into view. Re-armed whenever the page moves.
  const sentinelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!canLoadMore || sentinel === null || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && session.set({ shown: session.getState().shown + PAGE_SIZE }), { rootMargin: '160px 0px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [canLoadMore])

  const run = useCallback(async (slug: string, action: () => Promise<void>, fallback: string) => {
    setBusySlug(slug)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(getErrorMessage(cause, fallback))
    } finally {
      setBusySlug(null)
    }
  }, [])

  // `canSaveSelection` gates the button, so the element package is here by the time this runs.
  const startSave = (elementApi: ComponentElementApi) => {
    setError(null)
    try {
      const capture = captureComponentSelection(elementApi, excalidrawAPI)
      setCaptured(capture)
      setName('')
    } catch (cause) {
      setError(getErrorMessage(cause, 'The selection cannot be saved as a component'))
    }
  }

  const commitSave = async () => {
    if (captured === null || name.trim() === '') return
    setSaving(true)
    setError(null)
    try {
      const previewPng = await createScenePreviewPng(engine, {
        elements: captured.elements,
        appState: excalidrawAPI.getAppState() as unknown as Record<string, unknown>,
        files: captured.files,
      })
      const saved = await api.components.save({ name: name.trim(), fragmentJson: componentFragmentJson(captured), previewPng })
      setItems((current) => [saved, ...current.filter((row) => row.slug !== saved.slug)])
      setCaptured(null)
      setName('')
    } catch (cause) {
      setError(getErrorMessage(cause, 'The component could not be saved'))
    } finally {
      setSaving(false)
    }
  }

  /**
   * Import JSON (YAZ-1833): the native picker, the ported parser, then the SAME save door
   * "Save selection" uses. The name is the file's own base name; the preview is drawn from the
   * fragment and bounded like every other, so importing a whole board is allowed and its tile is
   * still a tile. A failure anywhere is a passive notice and NOTHING written.
   */
  const importJson = async () => {
    setError(null)
    setNotice(null)
    setImporting(true)
    try {
      const picked = await api.dialog.openDrawing()
      if ('cancelled' in picked) return
      const imported = parseImportedComponentJson(engine, picked.content)
      const previewPng = await createScenePreviewPng(engine, {
        elements: imported.elements,
        appState: excalidrawAPI.getAppState() as unknown as Record<string, unknown>,
        files: imported.files,
      })
      const saved = await api.components.save({ name: importedComponentName(picked.name), fragmentJson: componentFragmentJson(imported), previewPng })
      setItems((current) => [saved, ...current.filter((row) => row.slug !== saved.slug)])
    } catch (cause) {
      setNotice(getErrorMessage(cause, IMPORT_FAILED))
    } finally {
      setImporting(false)
    }
  }

  const insert = (item: ComponentItem) =>
    run(
      item.slug,
      async () => {
        const { fragmentJson } = await api.components.read({ slug: item.slug })
        insertComponent(engine, excalidrawAPI, fragmentJson)
      },
      `${item.name} could not be inserted`,
    )

  const commitRename = (item: ComponentItem) => {
    const next = renameValue.trim()
    setRenamingSlug(null)
    if (next === '' || next === item.name) return
    void run(
      item.slug,
      async () => {
        // The row takes the name the STORE answers with, and only once it answered: a refused
        // rename must never leave the new name on screen beside an error naming the old one.
        const renamed = await api.components.rename({ slug: item.slug, name: next })
        setItems((current) => current.map((row) => (row.slug === item.slug ? renamed : row)))
      },
      `${item.name} could not be renamed`,
    )
  }

  const remove = (item: ComponentItem) => {
    setConfirmingSlug(null)
    void run(
      item.slug,
      async () => {
        await api.components.delete({ slug: item.slug })
        setItems((current) => current.filter((row) => row.slug !== item.slug))
      },
      `${item.name} could not be deleted`,
    )
  }

  return (
    <section className="saved-components" aria-labelledby="saved-components-heading">
      <header className="saved-components__header">
        <div>
          <h2 id="saved-components-heading">Components</h2>
          <span>
            {items.length} saved component{items.length === 1 ? '' : 's'}
          </span>
        </div>
        <div className="saved-components__create-actions">
          <button
            type="button"
            onClick={() => element !== null && startSave(element)}
            disabled={!canSaveSelection}
            title={hasSelection ? 'Save selection' : NOTHING_SELECTED}
          >
            Save selection
          </button>
          <button type="button" onClick={() => void importJson()} disabled={importing} title="Import an .excalidraw file as a component">
            {importing ? 'Importing…' : 'Import JSON'}
          </button>
        </div>
      </header>

      {captured !== null && (
        <form
          className="saved-components__naming"
          onSubmit={(event) => {
            event.preventDefault()
            void commitSave()
          }}
        >
          <label>
            Name
            {/* Autofocused: the button that opened this form is the only way here. */}
            <input autoFocus value={name} maxLength={120} required aria-label="Component name" placeholder="Name this component" onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="saved-components__naming-actions">
            <button type="button" onClick={() => setCaptured(null)}>
              Cancel
            </button>
            <button type="submit" disabled={name.trim() === '' || saving}>
              {saving ? 'Saving…' : `Save ${captured.elements.length} element${captured.elements.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </form>
      )}

      <input
        type="search"
        className="saved-components__search"
        value={query}
        aria-label="Search components"
        placeholder="Search components"
        onChange={(event) => session.set({ query: event.target.value, shown: PAGE_SIZE })}
      />

      {notice !== null && (
        <div className="saved-components__notice" role="status">
          {notice}
        </div>
      )}
      {error !== null && (
        <div className="saved-components__error" role="alert">
          {error}
        </div>
      )}

      <div
        className="saved-components__content"
        ref={contentRef}
        onScroll={(event) => {
          scrollTop = event.currentTarget.scrollTop
        }}
      >
        {visible.length === 0 ? (
          <div className="saved-components__state">{query.trim() === '' ? EMPTY_LIBRARY : `No components match “${query}”`}</div>
        ) : (
          <div className="saved-components__grid">
            {visible.map((item) => (
              <article className="saved-components__card" key={item.slug} aria-busy={busySlug === item.slug}>
                <button
                  type="button"
                  className="saved-components__insert"
                  aria-label={`Insert ${item.name}`}
                  disabled={busySlug !== null}
                  onClick={() => void insert(item)}
                >
                  <span className="saved-components__preview">
                    <previews.Preview cacheKey={item.slug} placeholderClass="saved-components__placeholder" />
                  </span>
                  <span title={item.name}>{item.name}</span>
                </button>
                <button
                  type="button"
                  className="saved-components__options"
                  aria-label={`Options for ${item.name}`}
                  aria-expanded={openMenuSlug === item.slug}
                  onClick={() => setOpenMenuSlug((current) => (current === item.slug ? null : item.slug))}
                >
                  ⋯
                </button>
                {openMenuSlug === item.slug && renamingSlug !== item.slug && confirmingSlug !== item.slug && (
                  <div className="saved-components__menu">
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenuSlug(null)
                        setRenameValue(item.name)
                        setRenamingSlug(item.slug)
                      }}
                    >
                      Rename<span className="visually-hidden"> {item.name}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenuSlug(null)
                        // 🔒 confirmDelete off = delete straight away; the file goes to the Trash either way.
                        if (confirmDelete) setConfirmingSlug(item.slug)
                        else remove(item)
                      }}
                    >
                      Delete<span className="visually-hidden"> {item.name}</span>
                    </button>
                  </div>
                )}
                {renamingSlug === item.slug && (
                  <form
                    className="saved-components__inline"
                    onSubmit={(event) => {
                      event.preventDefault()
                      commitRename(item)
                    }}
                  >
                    {/* Autofocused: the menu item above is the only way here. */}
                    <input autoFocus value={renameValue} maxLength={120} aria-label={`Rename ${item.name}`} onChange={(event) => setRenameValue(event.target.value)} />
                    <button type="submit">Save</button>
                    <button type="button" onClick={() => setRenamingSlug(null)}>
                      Cancel
                    </button>
                  </form>
                )}
                {confirmingSlug === item.slug && (
                  <div className="saved-components__inline" role="alertdialog" aria-label={`Delete ${item.name}?`}>
                    <span>Delete “{item.name}”?</span>
                    <button type="button" onClick={() => remove(item)}>
                      Delete
                    </button>
                    <button type="button" onClick={() => setConfirmingSlug(null)}>
                      Cancel
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
        {canLoadMore && <div className="saved-components__sentinel" ref={sentinelRef} aria-hidden="true" />}
      </div>
      <footer className="saved-components__footer">Saved in your Library folder. Inserting makes an independent copy.</footer>
    </section>
  )
}
