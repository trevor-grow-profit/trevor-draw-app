import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_SETTINGS, MAX_RECENT_ROOTS, MAX_VAULT_NAME, SIDEBAR_DEFAULT_W, SIDEBAR_MAX_W, SIDEBAR_MIN_W, addRecentRoot, cleanVaultName, defaultAppState, type AppState, type WindowEntry } from '@shared/types'
import { createStore, isSettings } from './store'

// `rename` is the atomic write's last step: one rename = one write to disk.
vi.mock('node:fs/promises', async (importOriginal) => {
  const m = await importOriginal<typeof import('node:fs/promises')>()
  return { ...m, rename: vi.fn(m.rename) }
})
const renames = () => vi.mocked(rename).mock.calls.filter(([, to]) => String(to) === file)

let dir: string
let file: string
beforeEach(async () => {
  vi.mocked(rename).mockClear()
  dir = await mkdtemp(path.join(tmpdir(), 'yd-store-'))
  file = path.join(dir, 'yaseendraw.json')
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

const seed = (v: unknown) => writeFile(file, typeof v === 'string' ? v : JSON.stringify(v))
const onDisk = async (): Promise<AppState> => JSON.parse(await readFile(file, 'utf8')) as AppState
const bounds = { x: 1, y: 2, width: 300, height: 200 }
const win = (id: string, extra: Partial<WindowEntry> = {}): WindowEntry => ({ id, root: null, file: null, tabs: [], sidebarCollapsed: false, sidebarLens: 'favorites', focusDirs: [], focusFavorites: [], bounds, ...extra })
/** A seed with every field valid, to vary one field at a time. */
const valid = (over: Record<string, unknown> = {}) => ({ ...defaultAppState(), ...over })

describe('addRecentRoot', () => {
  it('prepends, de-dupes and caps at MAX_RECENT_ROOTS', () => {
    let list = addRecentRoot([], '/a', 1)
    list = addRecentRoot(list, '/b', 2)
    list = addRecentRoot(list, '/a', 3)
    expect(list).toEqual([
      { path: '/a', lastOpened: 3 },
      { path: '/b', lastOpened: 2 },
    ])
    for (let i = 0; i < 20; i++) list = addRecentRoot(list, `/x${i}`, 10 + i)
    expect(list).toHaveLength(MAX_RECENT_ROOTS)
    expect(list[0].path).toBe('/x19')
  })
})

describe('cleanVaultName (Docs YAZ-1974 D3)', () => {
  it('trims and caps a name; empty, whitespace or a non-string is null (= the folder name)', () => {
    expect(cleanVaultName('  Business Wiki  ')).toBe('Business Wiki')
    expect(cleanVaultName('🚀 Launch')).toBe('🚀 Launch')
    expect(cleanVaultName('x'.repeat(100))).toBe('x'.repeat(MAX_VAULT_NAME))
    expect(cleanVaultName('🚀'.repeat(100))).toBe('🚀'.repeat(MAX_VAULT_NAME))
    expect(cleanVaultName('')).toBeNull()
    expect(cleanVaultName('   ')).toBeNull()
    expect(cleanVaultName(5)).toBeNull()
    expect(cleanVaultName(null)).toBeNull()
    expect(cleanVaultName(undefined)).toBeNull()
  })
})

describe('createStore: loading', () => {
  it('a missing file yields the defaults and creates nothing until the first change', () => {
    const store = createStore(file)
    expect(store.get()).toEqual(defaultAppState())
    expect(existsSync(file)).toBe(false)
  })

  it('a valid file loads as is — except the session list, which a launch never restores (YAZ-1642)', async () => {
    const state: AppState = {
      version: 1,
      settings: { ...DEFAULT_SETTINGS, theme: 'dark', confirmDelete: false },
      sidebarWidth: 320,
      recents: [{ path: '/v', lastOpened: 5 }],
      windows: [win('w1', { root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw', '/v/b.excalidraw'], sidebarCollapsed: true, sidebarLens: 'files' })],
      folders: { '/v': { expanded: ['/v/sub'], lastFile: '/v/a.excalidraw', sortOrder: 'name', name: null } },
    }
    await seed(state)
    expect(createStore(file).get()).toEqual({ ...state, folders: { '/v': { ...state.folders['/v'], expanded: [] } } })
  })

  it('🔒 YAZ-1775 D9: the canvas prefs are repaired KEY BY KEY, not thrown away whole', async () => {
    // A store written before a key existed — everything it does hold survives.
    await seed(valid({ settings: { canvas: { gridModeEnabled: true, selectOn: 'overlap' } } }))
    expect(createStore(file).get().settings.canvas).toEqual({ ...DEFAULT_SETTINGS.canvas, gridModeEnabled: true, selectOn: 'overlap' })
    // One bad field defaults; its neighbours do not.
    await seed(valid({ settings: { canvas: { gridModeEnabled: true, defaultRoughness: 9, zenModeEnabled: 'yes' } } }))
    expect(createStore(file).get().settings.canvas).toEqual({ ...DEFAULT_SETTINGS.canvas, gridModeEnabled: true })
    // Junk in the slot is the defaults, never a crash.
    await seed(valid({ settings: { canvas: 'nope' } }))
    expect(createStore(file).get().settings.canvas).toEqual(DEFAULT_SETTINGS.canvas)
  })

  it('🔒 YAZ-1775 D10: the canvas panel`s memory survives an unknown tab by falling back to the default', async () => {
    await seed(valid({ settings: { canvasPanel: { tab: 'boards', docked: true } } }))
    expect(createStore(file).get().settings.canvasPanel).toEqual({ tab: 'components', docked: true })
    await seed(valid({ settings: { canvasPanel: { tab: 'image-studio' } } }))
    expect(createStore(file).get().settings.canvasPanel).toEqual({ tab: 'image-studio', docked: false })
  })

  it('🔒 YAZ-1775 D5: the library folder takes an ABSOLUTE path or null — never a relative one, never an empty string', async () => {
    await seed(valid({ settings: { libraryFolder: '/Vault/Library' } }))
    expect(createStore(file).get().settings.libraryFolder).toBe('/Vault/Library')
    for (const bad of ['', 'Library', 7]) {
      await seed(valid({ settings: { libraryFolder: bad } }))
      expect(createStore(file).get().settings.libraryFolder, String(bad)).toBeNull()
    }
  })

  it('settings fall back field by field (partial shapes, junk types)', async () => {
    await seed(valid({ settings: { confirmDelete: false } }))
    expect(createStore(file).get().settings).toEqual({ ...DEFAULT_SETTINGS, confirmDelete: false })
    await seed(valid({ settings: { theme: 'dark', confirmDelete: 'off' } }))
    expect(createStore(file).get().settings).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' })
    await seed(valid({ settings: { theme: 7, confirmDelete: false } }))
    expect(createStore(file).get().settings).toEqual({ ...DEFAULT_SETTINGS, confirmDelete: false })
    await seed(valid({ settings: 'nope' }))
    expect(createStore(file).get().settings).toEqual(DEFAULT_SETTINGS)
  })

  it('hoverPreview: an old file without it reads ON, junk falls back to ON, OFF survives; the IPC guard wants a boolean (YAZ-1800 D2)', async () => {
    const { hoverPreview: _omitted, ...preHoverSettings } = DEFAULT_SETTINGS
    await seed(valid({ settings: preHoverSettings }))
    expect(createStore(file).get().settings.hoverPreview).toBe(true)
    await seed(valid({ settings: { hoverPreview: 'no' } }))
    expect(createStore(file).get().settings.hoverPreview).toBe(true)
    await seed(valid({ settings: { hoverPreview: false } }))
    expect(createStore(file).get().settings.hoverPreview).toBe(false)
    expect(isSettings({ ...DEFAULT_SETTINGS, hoverPreview: 'on' })).toBe(false)
    expect(isSettings({ ...DEFAULT_SETTINGS, hoverPreview: false })).toBe(true)
  })

  it('diagramDarkColors: an old file without it reads adapt, junk falls back to adapt, keep survives; the IPC guard wants a known value (🔒 YAZ-1802 D16)', async () => {
    const { diagramDarkColors: _omitted, ...preSettings } = DEFAULT_SETTINGS
    await seed(valid({ settings: preSettings }))
    expect(createStore(file).get().settings.diagramDarkColors).toBe('adapt')
    await seed(valid({ settings: { diagramDarkColors: 'none' } }))
    expect(createStore(file).get().settings.diagramDarkColors).toBe('adapt')
    await seed(valid({ settings: { diagramDarkColors: 'keep' } }))
    expect(createStore(file).get().settings.diagramDarkColors).toBe('keep')
    expect(isSettings({ ...DEFAULT_SETTINGS, diagramDarkColors: 'auto' })).toBe(false)
    expect(isSettings({ ...DEFAULT_SETTINGS, diagramDarkColors: 'keep' })).toBe(true)
  })

  it('theme: an old settings object without the key sanitizes to system; junk falls back too (GRO-2218)', async () => {
    // A pre-K yaseendraw.json: every field but `theme` — the missing field must default, not corrupt the file.
    const { theme: _omitted, ...preThemeSettings } = DEFAULT_SETTINGS
    await seed(valid({ settings: preThemeSettings }))
    expect(createStore(file).get().settings.theme).toBe('system')
    await seed(valid({ settings: { ...DEFAULT_SETTINGS, theme: 'dark' } }))
    expect(createStore(file).get().settings.theme).toBe('dark')
    await seed(valid({ settings: { ...DEFAULT_SETTINGS, theme: 'blue' } }))
    expect(createStore(file).get().settings.theme).toBe('system')
    await seed(valid({ settings: { ...DEFAULT_SETTINGS, theme: 2 } }))
    expect(createStore(file).get().settings.theme).toBe('system')
  })

  it('sidebarCollapsed migrates from the legacy global value into each window, while a per-window boolean wins', async () => {
    await seed(
      valid({
        sidebarCollapsed: true,
        windows: [
          { id: 'legacy', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'], bounds },
          { id: 'new', root: '/v', file: null, tabs: [], bounds, sidebarCollapsed: false },
        ],
      }),
    )
    const store = createStore(file)
    const loaded = store.get() as unknown as { sidebarCollapsed?: unknown; windows: Array<{ sidebarCollapsed: boolean }> }
    expect(loaded).not.toHaveProperty('sidebarCollapsed')
    expect(loaded.windows.map((w) => w.sidebarCollapsed)).toEqual([true, false])

    // The next write completes the additive-within-v1 migration rather than preserving a
    // shadow global value that could later become a second source of truth.
    store.setSidebarWidth(321)
    await store.flush()
    const persisted = JSON.parse(await readFile(file, 'utf8')) as { sidebarCollapsed?: unknown; windows: Array<{ sidebarCollapsed: boolean }> }
    expect(persisted).not.toHaveProperty('sidebarCollapsed')
    expect(persisted.windows.map((w) => w.sidebarCollapsed)).toEqual([true, false])
  })

  it('sidebarCollapsed migration treats a missing or non-boolean legacy value as open', async () => {
    await seed(valid({ windows: [{ id: 'missing', root: null, file: null, tabs: [], bounds }] }))
    expect((createStore(file).get().windows[0] as unknown as { sidebarCollapsed: boolean }).sidebarCollapsed).toBe(false)

    await seed(valid({ sidebarCollapsed: 'true', windows: [{ id: 'junk', root: null, file: null, tabs: [], bounds }] }))
    expect((createStore(file).get().windows[0] as unknown as { sidebarCollapsed: boolean }).sidebarCollapsed).toBe(false)
  })

  it('sidebarWidth clamps a finite number and defaults when it is missing or junk', async () => {
    await seed(valid({ sidebarWidth: 5 }))
    expect(createStore(file).get().sidebarWidth).toBe(SIDEBAR_MIN_W)
    await seed(valid({ sidebarWidth: 9999 }))
    expect(createStore(file).get().sidebarWidth).toBe(SIDEBAR_MAX_W)
    await seed(valid({ sidebarWidth: '300' }))
    expect(createStore(file).get().sidebarWidth).toBe(SIDEBAR_DEFAULT_W)
    const { sidebarWidth: _omitted, ...preResize } = valid()
    await seed(preResize)
    expect(createStore(file).get().sidebarWidth).toBe(SIDEBAR_DEFAULT_W)
  })

  it('sidebarLens migrates from the legacy global value into each window, while a per-window lens wins (YAZ-847 → YAZ-1628)', async () => {
    await seed(
      valid({
        sidebarLens: 'files',
        windows: [
          { id: 'legacy', root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw'], bounds },
          { id: 'own', root: '/v', file: null, tabs: [], bounds, sidebarLens: 'favorites' },
          { id: 'junk', root: null, file: null, tabs: [], bounds, sidebarLens: 'graph' },
        ],
      }),
    )
    const store = createStore(file)
    const loaded = store.get() as unknown as { sidebarLens?: unknown; windows: Array<{ sidebarLens: string }> }
    expect(loaded).not.toHaveProperty('sidebarLens')
    expect(loaded.windows.map((w) => w.sidebarLens)).toEqual(['files', 'favorites', 'files'])

    // The next write completes the migration (the YAZ-1280 shape): no shadow global lens survives on disk.
    store.setSidebarWidth(321)
    await store.flush()
    const persisted = JSON.parse(await readFile(file, 'utf8')) as { sidebarLens?: unknown; windows: Array<{ sidebarLens: string }> }
    expect(persisted).not.toHaveProperty('sidebarLens')
    expect(persisted.windows.map((w) => w.sidebarLens)).toEqual(['files', 'favorites', 'files'])
  })

  it('sidebarLens migration treats a junk or missing legacy value as Files — a PRE-847 file has no key anywhere (YAZ-847, YAZ-1628)', async () => {
    await seed(valid({ sidebarLens: 'graph', windows: [{ id: 'w', root: null, file: null, tabs: [], bounds }] }))
    expect(createStore(file).get().windows[0].sidebarLens).toBe('files')
    await seed(valid({ sidebarLens: 1, windows: [{ id: 'w', root: null, file: null, tabs: [], bounds, sidebarLens: 1 }] }))
    expect(createStore(file).get().windows[0].sidebarLens).toBe('files')
    await seed(valid({ windows: [{ id: 'w', root: null, file: null, tabs: [], bounds }] }))
    expect(createStore(file).get().windows[0].sidebarLens).toBe('files')
  })

  it('recents: a wrong shape reads as empty, a long list is capped', async () => {
    await seed(valid({ recents: [{ path: '/a' }] }))
    expect(createStore(file).get().recents).toEqual([])
    await seed(valid({ recents: { '/a': 1 } }))
    expect(createStore(file).get().recents).toEqual([])
    const many = Array.from({ length: 15 }, (_, i) => ({ path: `/r${i}`, lastOpened: i }))
    await seed(valid({ recents: many }))
    expect(createStore(file).get().recents).toEqual(many.slice(0, MAX_RECENT_ROOTS))
  })

  it('windows: malformed entries are dropped, a non-array reads as empty', async () => {
    await seed(
      valid({
        windows: [
          win('ok', { root: '/v' }),
          { id: 'no-bounds', root: null, file: null },
          { id: 'bad-bounds', root: null, file: null, bounds: { x: 1, y: 2, width: 'w', height: 3 } },
          { id: 7, root: null, file: null, bounds },
          { id: 'bad-root', root: 5, file: null, bounds },
          'junk',
        ],
      }),
    )
    expect(createStore(file).get().windows).toEqual([win('ok', { root: '/v' })])
    await seed(valid({ windows: 'nope' }))
    expect(createStore(file).get().windows).toEqual([])
  })

  // Tabs (GRO-2232) are additive within version 1: an old build's sanitizer drops the unknown
  // `tabs` key and keeps using `file` (graceful downgrade); this build repairs the other way.
  it('tabs: a legacy entry without the key repairs from file ([file], or [] when file is null)', async () => {
    const legacy = (id: string, file: string | null) => ({ id, root: '/v', file, bounds })
    await seed(valid({ windows: [legacy('w1', '/v/a.excalidraw'), legacy('w2', null)] }))
    const windows = createStore(file).get().windows
    expect(windows[0].tabs).toEqual(['/v/a.excalidraw'])
    expect(windows[1].tabs).toEqual([])
  })

  it('tabs: junk elements (non-strings, relative paths) drop; duplicates de-dupe keeping the first; order survives', async () => {
    await seed(valid({ windows: [win('w1', { root: '/v', file: '/v/a.excalidraw', tabs: ['/v/a.excalidraw', 5, 'rel.excalidraw', '/v/b.excalidraw', '/v/a.excalidraw', null, '/v/b.excalidraw'] as never })] }))
    expect(createStore(file).get().windows[0].tabs).toEqual(['/v/a.excalidraw', '/v/b.excalidraw'])
  })

  it('tabs: a non-null file missing from tabs is prepended (file IS the active tab)', async () => {
    await seed(valid({ windows: [win('w1', { root: '/v', file: '/v/a.excalidraw', tabs: ['/v/b.excalidraw', '/v/c.excalidraw'] })] }))
    expect(createStore(file).get().windows[0].tabs).toEqual(['/v/a.excalidraw', '/v/b.excalidraw', '/v/c.excalidraw'])
  })

  it('tabs: a null file clears the list (tabs [] ⇔ file null) and a non-array reads as the repair path', async () => {
    await seed(valid({ windows: [win('w1', { root: '/v', file: null, tabs: ['/v/orphan.excalidraw'] })] }))
    expect(createStore(file).get().windows[0].tabs).toEqual([])
    await seed(valid({ windows: [win('w1', { root: '/v', file: '/v/a.excalidraw', tabs: 'nope' as never })] }))
    expect(createStore(file).get().windows[0].tabs).toEqual(['/v/a.excalidraw'])
  })

  it('folders: each folder entry falls back field by field; a non-record entry is dropped', async () => {
    await seed(
      valid({
        folders: {
          '/a': { expanded: 'nope', lastFile: 5 },
          '/b': 'nope',
          '/c': { expanded: ['/c/sub'], lastFile: '/c/a.excalidraw', sortOrder: 'name' },
          '/d': {},
        },
      }),
    )
    const { folders } = createStore(file).get()
    expect(folders['/a']).toEqual({ expanded: [], lastFile: null, sortOrder: 'name', name: null })
    expect(folders['/b']).toBeUndefined()
    expect(folders['/c'].expanded).toEqual([]) // a session list: the file's value is ignored (YAZ-1642)
    expect(folders['/c'].lastFile).toBe('/c/a.excalidraw')
    expect(folders['/d']).toEqual({ expanded: [], lastFile: null, sortOrder: 'name', name: null })
    await seed(valid({ folders: [] }))
    expect(createStore(file).get().folders).toEqual({})
  })

  it('windows: focusDirs / focusFavorites load with the tabs rule — relative elements drop, a missing or junk list is no focus (YAZ-1628)', async () => {
    await seed(
      valid({
        windows: [
          { id: 'a', root: '/v', file: null, tabs: [], bounds, focusDirs: ['/v/x', 'rel', '/v/y'], focusFavorites: ['/v/f'] },
          { id: 'b', root: '/v', file: null, tabs: [], bounds }, // pre-1628 entry: no focus fields
          { id: 'c', root: '/v', file: null, tabs: [], bounds, focusDirs: '/v/x', focusFavorites: [1] },
        ],
      }),
    )
    const { windows } = createStore(file).get()
    expect(windows[0]).toMatchObject({ focusDirs: ['/v/x', '/v/y'], focusFavorites: ['/v/f'] })
    expect(windows[1]).toMatchObject({ focusDirs: [], focusFavorites: [] })
    expect(windows[2]).toMatchObject({ focusDirs: [], focusFavorites: [] }) // junk voids the list, like `tabs`
  })

  it('a legacy per-vault focus (folders[root].focusDirs, pre-1628) is dropped on load and absent from the written file', async () => {
    await seed(
      valid({
        windows: [{ id: 'w1', root: '/v', file: null, tabs: [], bounds }],
        folders: { '/v': { expanded: [], lastFile: null, favorites: [], focusDirs: ['/v/x'], focusFavorites: [] } },
      }),
    )
    const store = createStore(file)
    // No migration: the vault bucket could not say WHICH window was focused, so every window starts unfocused.
    expect(store.get().folders['/v']).toEqual({ expanded: [], lastFile: null, sortOrder: 'name', name: null })
    expect(store.get().windows[0]).toMatchObject({ focusDirs: [], focusFavorites: [] })
    store.setSidebarWidth(321)
    await store.flush()
    const persisted = JSON.parse(await readFile(file, 'utf8')) as { folders: Record<string, Record<string, unknown>> }
    expect(persisted.folders['/v']).not.toHaveProperty('focusDirs')
    expect(persisted.folders['/v']).not.toHaveProperty('focusFavorites')
  })

  it('folders: sortOrder loads as stored, a junk or missing value reads as name, and it survives a relaunch (🔒 YAZ-1835 D3)', async () => {
    await seed(
      valid({
        folders: {
          '/a': { lastFile: null, sortOrder: 'created' },
          '/b': { lastFile: null }, // a pre-1835 file
          '/c': { lastFile: null, sortOrder: 'opened' }, // never a value; dropped, not migrated
        },
      }),
    )
    const store = createStore(file)
    expect(store.get().folders['/a'].sortOrder).toBe('created')
    expect(store.get().folders['/b'].sortOrder).toBe('name')
    expect(store.get().folders['/c'].sortOrder).toBe('name')
    store.setFolder('/b', { sortOrder: 'updated' })
    await store.flush()
    expect(createStore(file).get().folders['/b']).toEqual({ expanded: [], lastFile: null, sortOrder: 'updated', name: null })
  })

  it('folders: expanded is a session list — present, junk or missing, a launch reads it as [] (YAZ-1642)', async () => {
    await seed(
      valid({
        folders: {
          '/a': { expanded: ['/a/sub'], lastFile: null, sortOrder: 'name' }, // a pre-1642 file still carrying it
          '/b': { lastFile: null }, // what this version writes: no key
          '/c': { expanded: 'nope', lastFile: null },
        },
      }),
    )
    const { folders } = createStore(file).get()
    for (const root of ['/a', '/b', '/c']) expect(folders[root].expanded).toEqual([])
  })

  it('unknown top-level keys are dropped', async () => {
    await seed(valid({ extra: 1 }))
    expect(createStore(file).get()).toEqual(defaultAppState())
  })

  it.each([
    ['unparsable JSON', '{broken'],
    ['not an object', '[]'],
    ['wrong version', JSON.stringify(valid({ version: 2 }))],
  ])('a corrupt file (%s) is moved to yaseendraw.json.corrupt-<epoch> and the defaults are used', async (_name, raw) => {
    await seed(raw)
    const store = createStore(file)
    expect(store.get()).toEqual(defaultAppState())
    expect(existsSync(file)).toBe(false)
    const backups = (await readdir(dir)).filter((n) => /^yaseendraw\.json\.corrupt-\d+$/.test(n))
    expect(backups).toHaveLength(1)
    expect(await readFile(path.join(dir, backups[0]), 'utf8')).toBe(raw)
  })
})

describe('createStore: mutations', () => {
  it('setSettings replaces the value and notifies listeners synchronously with the new state', () => {
    const store = createStore(file)
    const seen: AppState[] = []
    const off = store.onChange((s) => seen.push(s))
    const before = store.get()
    store.setSettings({ ...DEFAULT_SETTINGS, confirmDelete: false })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(store.get())
    expect(store.get().settings.confirmDelete).toBe(false)
    expect(before.settings.confirmDelete).toBe(DEFAULT_SETTINGS.confirmDelete) // snapshots are immutable
    off()
    store.setSettings(DEFAULT_SETTINGS)
    expect(seen).toHaveLength(1)
  })

  it('pushRecent is MRU, de-duplicated and capped', () => {
    const store = createStore(file)
    store.pushRecent('/a', 1)
    store.pushRecent('/b', 2)
    store.pushRecent('/a', 3)
    expect(store.get().recents).toEqual([
      { path: '/a', lastOpened: 3 },
      { path: '/b', lastOpened: 2 },
    ])
    for (let i = 0; i < 20; i++) store.pushRecent(`/x${i}`, 10 + i)
    expect(store.get().recents).toHaveLength(MAX_RECENT_ROOTS)
    expect(store.get().recents[0].path).toBe('/x19')
    store.pushRecent('/now')
    expect(store.get().recents[0].lastOpened).toBeGreaterThan(0)
  })

  it('removeRecent drops the entry; removing an unknown path changes (and notifies) nothing', () => {
    const store = createStore(file)
    const seen: AppState[] = []
    store.onChange((s) => seen.push(s))
    store.pushRecent('/a', 1)
    store.pushRecent('/b', 2)
    store.removeRecent('/a')
    expect(store.get().recents).toEqual([{ path: '/b', lastOpened: 2 }])
    expect(seen).toHaveLength(3)
    store.removeRecent('/gone') // no change → no notification
    expect(seen).toHaveLength(3)
    expect(store.get().recents).toEqual([{ path: '/b', lastOpened: 2 }])
  })

  it('setFolder creates the entry with defaults, merges the patch and ignores unknown keys', () => {
    const store = createStore(file)
    store.setFolder('/r1', { expanded: ['/r1/a'] })
    expect(store.get().folders['/r1']).toEqual({ expanded: ['/r1/a'], lastFile: null, sortOrder: 'name', name: null })
    store.setFolder('/r1', { lastFile: '/r1/a/x.excalidraw' })
    expect(store.get().folders['/r1']).toEqual({ expanded: ['/r1/a'], lastFile: '/r1/a/x.excalidraw', sortOrder: 'name', name: null })
    store.setFolder('/r1', { lastFile: null, openedAt: 5 } as never)
    expect(store.get().folders['/r1']).toEqual({ expanded: ['/r1/a'], lastFile: null, sortOrder: 'name', name: null })
    store.setFolder('/r1', { sortOrder: 'updated' })
    expect(store.get().folders['/r1']).toEqual({ expanded: ['/r1/a'], lastFile: null, sortOrder: 'updated', name: null })
    store.setFolder('/r2', {})
    expect(store.get().folders['/r2']).toEqual({ expanded: [], lastFile: null, sortOrder: 'name', name: null })
  })

  it('setFolder cleans the display name, other patches leave it alone, and removeRecent keeps it (Docs YAZ-1974 D3)', () => {
    const store = createStore(file)
    store.pushRecent('/v', 1)
    store.setFolder('/v', { name: '  Business Wiki  ' })
    expect(store.get().folders['/v'].name).toBe('Business Wiki')
    store.setFolder('/v', { lastFile: '/v/a.excalidraw', sortOrder: 'updated' })
    store.removeRecent('/v') // forgets the MRU entry only — folders are not pruned with recents
    expect(store.get().folders['/v'].name).toBe('Business Wiki')
    store.setFolder('/v', { name: 'x'.repeat(MAX_VAULT_NAME + 20) })
    expect(store.get().folders['/v'].name).toHaveLength(MAX_VAULT_NAME)
    store.setFolder('/v', { name: '   ' })
    expect(store.get().folders['/v'].name).toBeNull()
  })

  it('two windows on one root hold independent focusDirs / focusFavorites — upsertWindow on one leaves the other untouched (YAZ-1628)', () => {
    const store = createStore(file)
    store.upsertWindow(win('w1', { root: '/v', focusDirs: ['/v/a', '/v/b'], focusFavorites: ['/v/F'] }))
    store.upsertWindow(win('w2', { root: '/v', focusDirs: ['/v/c'] }))
    expect(store.get().windows[0]).toMatchObject({ focusDirs: ['/v/a', '/v/b'], focusFavorites: ['/v/F'] })
    expect(store.get().windows[1]).toMatchObject({ focusDirs: ['/v/c'], focusFavorites: [] })
    store.upsertWindow({ ...store.get().windows[0], focusDirs: [] }) // one window's exit leaves its other lens AND the other window alone
    expect(store.get().windows[0]).toMatchObject({ focusDirs: [], focusFavorites: ['/v/F'] })
    expect(store.get().windows[1]).toMatchObject({ focusDirs: ['/v/c'], focusFavorites: [] })
  })

  it('upsertWindow replaces by id or appends; removeWindow drops by id', () => {
    const store = createStore(file)
    store.upsertWindow(win('w1'))
    store.upsertWindow(win('w2', { root: '/v' }))
    store.upsertWindow(win('w1', { root: '/other', file: '/other/a.excalidraw' }))
    expect(store.get().windows).toEqual([win('w1', { root: '/other', file: '/other/a.excalidraw', tabs: ['/other/a.excalidraw'] }), win('w2', { root: '/v' })])
    store.removeWindow('w1')
    expect(store.get().windows).toEqual([win('w2', { root: '/v' })])
    store.removeWindow('nope')
    expect(store.get().windows).toEqual([win('w2', { root: '/v' })])
  })

  describe('renamePath (Links E1, GRO-2194: the store repair after an in-app rename)', () => {
    const OLD = '/v/B.excalidraw'
    const NEW = '/v/C.excalidraw'

    it('remaps window file and tabs (through normalizeTabs) in every affected window', () => {
      const store = createStore(file)
      store.upsertWindow(win('w1', { root: '/v', file: OLD, tabs: [OLD, '/v/x.excalidraw'] }))
      store.upsertWindow(win('w2', { root: '/v', file: '/v/x.excalidraw', tabs: ['/v/x.excalidraw', OLD] }))
      store.upsertWindow(win('w3', { root: '/other', file: '/other/a.excalidraw', tabs: ['/other/a.excalidraw'] }))
      store.renamePath(OLD, NEW)
      expect(store.get().windows).toEqual([
        win('w1', { root: '/v', file: NEW, tabs: [NEW, '/v/x.excalidraw'] }),
        win('w2', { root: '/v', file: '/v/x.excalidraw', tabs: ['/v/x.excalidraw', NEW] }),
        win('w3', { root: '/other', file: '/other/a.excalidraw', tabs: ['/other/a.excalidraw'] }),
      ])
    })

    it('de-duplicates when the new path was somehow already a tab (normalizeTabs invariant)', () => {
      const store = createStore(file)
      store.upsertWindow(win('w1', { root: '/v', file: OLD, tabs: [OLD, NEW] }))
      store.renamePath(OLD, NEW)
      expect(store.get().windows[0].tabs).toEqual([NEW])
      expect(store.get().windows[0].file).toBe(NEW)
    })

    it('remaps folders: the renamed lastFile follows, the others are untouched', () => {
      const store = createStore(file)
      store.setFolder('/v', { lastFile: OLD })
      store.setFolder('/other', { lastFile: '/other/a.excalidraw' })
      store.renamePath(OLD, NEW)
      expect(store.get().folders['/v'].lastFile).toBe(NEW)
      expect(store.get().folders['/other'].lastFile).toBe('/other/a.excalidraw')
    })

    it('a rename nothing references changes (and notifies) nothing', () => {
      const store = createStore(file)
      store.upsertWindow(win('w1', { root: '/v', file: '/v/x.excalidraw', tabs: ['/v/x.excalidraw'] }))
      const seen: AppState[] = []
      store.onChange((s) => seen.push(s))
      store.renamePath('/v/unreferenced.excalidraw', '/v/other.excalidraw')
      expect(seen).toHaveLength(0)
      expect(store.get().windows).toEqual([win('w1', { root: '/v', file: '/v/x.excalidraw', tabs: ['/v/x.excalidraw'] })])
    })
  })

  describe('removePath (GRO-2272: the store repair after an in-app delete)', () => {
    it('drops focusDirs / focusFavorites entries at or under the deleted path in every window, like tabs (YAZ-1628)', () => {
      const store = createStore(file)
      store.upsertWindow(win('w1', { root: '/v', focusDirs: ['/v/Sub', '/v/Sub/deep', '/v/other'], focusFavorites: ['/v/Sub/Fav', '/v/Home'] }))
      store.upsertWindow(win('w2', { root: '/v', focusDirs: ['/v/Sub'], focusFavorites: [] }))
      store.removePath('/v/Sub')
      expect(store.get().windows[0]).toMatchObject({ focusDirs: ['/v/other'], focusFavorites: ['/v/Home'] })
      expect(store.get().windows[1]).toMatchObject({ focusDirs: [], focusFavorites: [] }) // the last one leaving ends the focus
    })

    const GONE = '/v/B.excalidraw'

    it('deleting the ONLY tab leaves the window empty (file null, tabs [])', () => {
      const store = createStore(file)
      store.upsertWindow(win('w1', { root: '/v', file: GONE, tabs: [GONE] }))
      store.removePath(GONE)
      expect(store.get().windows[0].file).toBeNull()
      expect(store.get().windows[0].tabs).toEqual([])
    })

    it('deleting the ACTIVE tab promotes the right neighbour, else the left — never discards survivors', () => {
      const store = createStore(file)
      store.upsertWindow(win('w1', { root: '/v', file: GONE, tabs: ['/v/left.excalidraw', GONE, '/v/right.excalidraw'] }))
      store.removePath(GONE)
      expect(store.get().windows[0].file).toBe('/v/right.excalidraw')
      expect(store.get().windows[0].tabs).toEqual(['/v/left.excalidraw', '/v/right.excalidraw'])
      // No right neighbour: fall back to the nearest surviving tab on the left.
      const store2 = createStore(`${file}.2`)
      store2.upsertWindow(win('w2', { root: '/v', file: GONE, tabs: ['/v/left.excalidraw', GONE] }))
      store2.removePath(GONE)
      expect(store2.get().windows[0].file).toBe('/v/left.excalidraw')
    })

    it('drops the deleted tab and keeps the window on a surviving active file', () => {
      const store = createStore(file)
      store.upsertWindow(win('w1', { root: '/v', file: '/v/x.excalidraw', tabs: ['/v/x.excalidraw', GONE] }))
      store.upsertWindow(win('w2', { root: '/other', file: '/other/a.excalidraw', tabs: ['/other/a.excalidraw'] }))
      store.removePath(GONE)
      expect(store.get().windows).toEqual([
        win('w1', { root: '/v', file: '/v/x.excalidraw', tabs: ['/v/x.excalidraw'] }),
        win('w2', { root: '/other', file: '/other/a.excalidraw', tabs: ['/other/a.excalidraw'] }),
      ])
    })

    it('leaves window ROOT alone — the renderer onRootMissing probe owns that repair', () => {
      const store = createStore(file)
      store.upsertWindow(win('w1', { root: '/v/Sub', file: '/v/Sub/a.excalidraw', tabs: ['/v/Sub/a.excalidraw'] }))
      store.removePath('/v/Sub')
      expect(store.get().windows[0].root).toBe('/v/Sub') // untouched by design
      expect(store.get().windows[0].file).toBeNull() // the file under it still goes
      expect(store.get().windows[0].tabs).toEqual([])
    })

    it('a DIRECTORY removes by prefix: every file and tab under it goes, siblings stay', () => {
      const store = createStore(file)
      store.upsertWindow(win('w1', { root: '/v', file: '/v/Old/a.excalidraw', tabs: ['/v/Old/a.excalidraw', '/v/x.excalidraw', '/v/Old/deep/b.excalidraw'] }))
      store.removePath('/v/Old')
      expect(store.get().windows[0].file).toBe('/v/x.excalidraw')
      expect(store.get().windows[0].tabs).toEqual(['/v/x.excalidraw'])
    })

    it('a prefix must be a real path segment: /v/Older is not under /v/Old', () => {
      const store = createStore(file)
      store.upsertWindow(win('w1', { root: '/v', file: '/v/Older.excalidraw', tabs: ['/v/Older.excalidraw'] }))
      store.removePath('/v/Old')
      expect(store.get().windows[0].tabs).toEqual(['/v/Older.excalidraw'])
    })

    it('drops the recents entry for a deleted folder', () => {
      const store = createStore(file)
      store.pushRecent('/v/Sub')
      store.pushRecent('/v/Keep')
      store.removePath('/v/Sub')
      expect(store.get().recents.map((r) => r.path)).toEqual(['/v/Keep'])
    })

    it('drops folder state at or under the path: the key itself, expanded and lastFile', () => {
      const store = createStore(file)
      store.setFolder('/v', { lastFile: GONE, expanded: ['/v/Old', '/v/Keep'] })
      store.removePath(GONE)
      expect(store.get().folders['/v'].lastFile).toBeNull()
      store.removePath('/v/Old')
      expect(store.get().folders['/v'].expanded).toEqual(['/v/Keep'])
    })

    it('drops the whole folder-state entry when the deleted folder was itself a stored root — its display name with it (Docs YAZ-1974 D3)', () => {
      const store = createStore(file)
      store.setFolder('/v/Sub', { lastFile: '/v/Sub/a.excalidraw', name: 'Sub Vault' })
      store.setFolder('/v/Keep', { lastFile: '/v/Keep/b.excalidraw' })
      store.removePath('/v/Sub')
      expect(Object.keys(store.get().folders)).toEqual(['/v/Keep'])
    })

    it('a delete nothing references changes (and notifies) nothing', () => {
      const store = createStore(file)
      store.upsertWindow(win('w1', { root: '/v', file: '/v/x.excalidraw', tabs: ['/v/x.excalidraw'] }))
      const seen: AppState[] = []
      store.onChange((s) => seen.push(s))
      store.removePath('/v/unreferenced.excalidraw')
      expect(seen).toHaveLength(0)
    })

    it('commits ONCE for a delete that touches several places at once', () => {
      const store = createStore(file)
      store.upsertWindow(win('w1', { root: '/v', file: GONE, tabs: [GONE] }))
      store.upsertWindow(win('w2', { root: '/v', file: '/v/x.excalidraw', tabs: ['/v/x.excalidraw', GONE] }))
      store.setFolder('/v', { lastFile: GONE })
      const seen: AppState[] = []
      store.onChange((s) => seen.push(s))
      store.removePath(GONE)
      expect(seen).toHaveLength(1)
    })
  })

  describe('renamePath with a DIRECTORY (Links E1b, GRO-2241: prefix repair)', () => {
    const OLD = '/v/Old'
    const NEW = '/v/New'

    it('remaps every window path at or under the dir — file, tabs, and a window ROOTED at (or under) it — in one commit', () => {
      const store = createStore(file)
      store.upsertWindow(win('w1', { root: '/v', file: `${OLD}/a.excalidraw`, tabs: [`${OLD}/a.excalidraw`, '/v/x.excalidraw', `${OLD}/deep/b.excalidraw`] }))
      store.upsertWindow(win('w2', { root: OLD, file: `${OLD}/a.excalidraw`, tabs: [`${OLD}/a.excalidraw`] })) // the subfolder opened as a vault
      store.upsertWindow(win('w3', { root: `${OLD}/deep`, file: null, tabs: [] }))
      store.upsertWindow(win('w4', { root: '/other', file: '/other/a.excalidraw', tabs: ['/other/a.excalidraw'] }))
      const seen: AppState[] = []
      store.onChange((s) => seen.push(s))
      store.renamePath(OLD, NEW)
      expect(seen).toHaveLength(1) // ONE commit, one notify, for the whole repair
      expect(store.get().windows).toEqual([
        win('w1', { root: '/v', file: `${NEW}/a.excalidraw`, tabs: [`${NEW}/a.excalidraw`, '/v/x.excalidraw', `${NEW}/deep/b.excalidraw`] }),
        win('w2', { root: NEW, file: `${NEW}/a.excalidraw`, tabs: [`${NEW}/a.excalidraw`] }),
        win('w3', { root: `${NEW}/deep`, file: null, tabs: [] }),
        win('w4', { root: '/other', file: '/other/a.excalidraw', tabs: ['/other/a.excalidraw'] }),
      ])
    })

    it('remaps focusDirs / focusFavorites at or under the dir in every window rooted there — a focused dir INSIDE the renamed folder follows it, one outside is untouched (YAZ-1628)', () => {
      const store = createStore(file)
      store.upsertWindow(win('w1', { root: '/v', focusDirs: [`${OLD}/deep`, '/v/other'], focusFavorites: [`${OLD}/Fav`, '/v/Home'] }))
      store.upsertWindow(win('w2', { root: '/v', focusDirs: [OLD], focusFavorites: [] }))
      store.upsertWindow(win('w3', { root: '/other', focusDirs: ['/other/x'], focusFavorites: [] }))
      store.renamePath(OLD, NEW)
      expect(store.get().windows[0]).toMatchObject({ focusDirs: [`${NEW}/deep`, '/v/other'], focusFavorites: [`${NEW}/Fav`, '/v/Home'] })
      expect(store.get().windows[1]).toMatchObject({ focusDirs: [NEW], focusFavorites: [] })
      expect(store.get().windows[2]).toMatchObject({ focusDirs: ['/other/x'], focusFavorites: [] })
    })

    it('remaps folder state under the dir: lastFile and expanded dirs — and the folder-state KEY of a root at/under it', () => {
      const store = createStore(file)
      store.setFolder('/v', { lastFile: `${OLD}/a.excalidraw`, expanded: [OLD, `${OLD}/deep`, '/v/other'] })
      store.setFolder(OLD, { lastFile: `${OLD}/a.excalidraw` }) // the subfolder's own folder-state entry (it was opened as a root)
      store.renamePath(OLD, NEW)
      expect(store.get().folders['/v']).toEqual({
        lastFile: `${NEW}/a.excalidraw`,
        expanded: [NEW, `${NEW}/deep`, '/v/other'],
        sortOrder: 'name',
        name: null,
      })
      expect(store.get().folders[OLD]).toBeUndefined()
      expect(store.get().folders[NEW]).toEqual({ lastFile: `${NEW}/a.excalidraw`, expanded: [], sortOrder: 'name', name: null })
    })

    it('a renamed vault ROOT keeps its display name under the new key (Docs YAZ-1974 D3)', () => {
      const store = createStore(file)
      store.setFolder(OLD, { name: 'Old Notes' })
      store.renamePath(OLD, NEW)
      expect(store.get().folders[NEW].name).toBe('Old Notes')
      expect(store.get().folders[OLD]).toBeUndefined()
    })

    it('remaps a recents entry at or under the dir (a subfolder that was opened as a vault)', () => {
      const store = createStore(file)
      store.pushRecent('/other', 1)
      store.pushRecent(OLD, 2)
      store.renamePath(OLD, NEW)
      expect(store.get().recents.map((r) => r.path)).toEqual([NEW, '/other'])
    })

    it('a FILE rename never trips the prefix branch (nothing is stored under a file path)', () => {
      const store = createStore(file)
      store.upsertWindow(win('w1', { root: '/v', file: '/v/B.excalidraw', tabs: ['/v/B.excalidraw', '/v/B.excalidraw.excalidraw'] }))
      store.renamePath('/v/B.excalidraw', '/v/C.excalidraw')
      // `/v/B.excalidraw.excalidraw` does NOT start with `/v/B.excalidraw/` — only the exact match moved.
      expect(store.get().windows[0].tabs).toEqual(['/v/C.excalidraw', '/v/B.excalidraw.excalidraw'])
    })
  })
})

describe('createStore: persistence', () => {
  it('restores opposite sidebar values for two windows after a real flush and reload (YAZ-1280)', async () => {
    const store = createStore(file)
    store.upsertWindow(win('open', { root: '/v', sidebarCollapsed: false }))
    store.upsertWindow(win('closed', { root: '/w', sidebarCollapsed: true }))
    await store.flush()
    expect(createStore(file).get().windows.map(({ id, sidebarCollapsed }) => ({ id, sidebarCollapsed }))).toEqual([
      { id: 'open', sidebarCollapsed: false },
      { id: 'closed', sidebarCollapsed: true },
    ])
  })

  it('coalesces a burst of changes into one debounced atomic write that matches get()', async () => {
    vi.useFakeTimers()
    const store = createStore(file)
    store.setSidebarWidth(321)
    store.pushRecent('/v', 1)
    store.setFolder('/v', { lastFile: '/v/a.excalidraw' })
    await vi.advanceTimersByTimeAsync(100)
    expect(existsSync(file)).toBe(false)
    await vi.advanceTimersByTimeAsync(60)
    await store.flush()
    expect(renames()).toHaveLength(1)
    expect(await onDisk()).toEqual({ ...store.get(), folders: { '/v': { lastFile: '/v/a.excalidraw', sortOrder: 'name', name: null } } })
    expect((await readdir(dir)).filter((n) => n.includes('.tmp-'))).toEqual([])
  })

  it('the session list lives in get() for every window but never reaches disk, so a relaunch starts collapsed (YAZ-1642)', async () => {
    const store = createStore(file)
    store.setFolder('/v', { expanded: ['/v/sub'] })
    expect(store.get().folders['/v']).toEqual({ expanded: ['/v/sub'], lastFile: null, sortOrder: 'name', name: null })
    await store.flush()
    expect((await onDisk()).folders['/v']).toEqual({ lastFile: null, sortOrder: 'name', name: null })
    expect(createStore(file).get().folders['/v']).toEqual({ expanded: [], lastFile: null, sortOrder: 'name', name: null })
  })

  it('the display name is persisted and restored; a junk one reads as null (Docs YAZ-1974 D3)', async () => {
    const store = createStore(file)
    store.setFolder('/v', { name: 'Business Wiki' })
    await store.flush()
    expect((await onDisk()).folders['/v'].name).toBe('Business Wiki')
    expect(createStore(file).get().folders['/v'].name).toBe('Business Wiki')
    await seed(valid({ folders: { '/v': { lastFile: null, name: 42 } } }))
    expect(createStore(file).get().folders['/v'].name).toBeNull()
  })

  it('flush writes at once, cancels the pending timer, and is a no-op when nothing changed', async () => {
    vi.useFakeTimers()
    const store = createStore(file)
    await store.flush()
    expect(existsSync(file)).toBe(false)
    store.setSettings({ ...DEFAULT_SETTINGS, confirmDelete: false })
    await store.flush()
    expect((await onDisk()).settings.confirmDelete).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    await store.flush()
    expect(renames()).toHaveLength(1)
  })

  it('a change that moves nothing on disk writes nothing: a session-only folder toggle, or the same settings again (YAZ-2073 5G)', async () => {
    const store = createStore(file)
    store.setFolder('/v', { lastFile: '/v/a.excalidraw' })
    await store.flush()
    expect(renames()).toHaveLength(1)
    // `expanded` never reaches disk (YAZ-1642): listeners still hear it, the file is not rewritten.
    const heard = vi.fn()
    store.onChange(heard)
    store.setFolder('/v', { expanded: ['/v/sub'] })
    store.setSettings({ ...store.get().settings })
    await store.flush()
    expect(heard).toHaveBeenCalledTimes(2)
    expect(renames()).toHaveLength(1)
    // A change that does move the file still lands.
    store.setSidebarWidth(SIDEBAR_MIN_W)
    await store.flush()
    expect(renames()).toHaveLength(2)
    expect((await onDisk()).sidebarWidth).toBe(SIDEBAR_MIN_W)
  })

  it('the file on disk is the pretty-printed state and the parent directory is created on demand', async () => {
    const nested = path.join(dir, 'deeper', 'yaseendraw.json')
    const store = createStore(nested)
    store.upsertWindow(win('w1', { root: '/v' }))
    await store.flush()
    const raw = await readFile(nested, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw.split('\n').length).toBeGreaterThan(5)
    expect(JSON.parse(raw)).toEqual(store.get())
    expect(createStore(nested).get()).toEqual(store.get())
  })
})

/**
 * Favorites' per-window focus list (YAZ-1766 D5): `WindowEntry.focusFavorites` rides `focusDirs`'
 * rules — path-keyed, so `renamePath` / `removePath` repair it exactly as they repair `focusDirs`.
 * (The favorites LIST itself left this store for `.yaseendraw/favorites.json` in 6A/D15 — see `favorites.test.ts`.)
 */
describe('focusFavorites (YAZ-1766 D5)', () => {
  it('windows: focusFavorites loads with the tabs rule, upserts and duplicates by value', async () => {
    await seed(valid({ windows: [{ id: 'a', root: '/v', file: null, tabs: [], bounds, focusFavorites: ['/v/x', 'rel'] }, { id: 'b', root: '/v', file: null, tabs: [], bounds, focusFavorites: 1 }] }))
    const store = createStore(file)
    expect(store.get().windows[0]).toMatchObject({ focusFavorites: ['/v/x'] })
    expect(store.get().windows[1]).toMatchObject({ focusFavorites: [] })
    store.upsertWindow(win('c', { root: '/v', focusFavorites: ['/v/a'] }))
    expect(store.get().windows[2]).toMatchObject({ focusFavorites: ['/v/a'] })
  })

  it('renamePath remaps a focused dir and everything under it in every window\'s focusFavorites', () => {
    const store = createStore(file)
    store.upsertWindow(win('w1', { root: '/v', focusFavorites: ['/v/Sub', '/v/Sub/deep', '/v/other'] }))
    store.renamePath('/v/Sub', '/v/Moved')
    expect(store.get().windows[0]).toMatchObject({ focusFavorites: ['/v/Moved', '/v/Moved/deep', '/v/other'] })
  })

  it('removePath drops a deleted focus dir from focusFavorites', () => {
    const store = createStore(file)
    store.upsertWindow(win('w1', { root: '/v', focusFavorites: ['/v/Sub', '/v/other'] }))
    store.removePath('/v/Sub')
    expect(store.get().windows[0]).toMatchObject({ focusFavorites: ['/v/other'] })
  })
})
