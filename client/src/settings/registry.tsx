/**
 * THE SETTINGS REGISTRY (YAZ-1679 D2): one array the dialog's nav, page rendering and search all
 * read. A setting is declared ONCE — id, label, hint, search keywords, and how it renders — and
 * appears in its section, in a search result, and in the nav's section list from that one entry.
 * The persistence layer (`SettingsState`, `storage.setSettings`, per-vault `github.json`) is
 * separate and untouched.
 *
 * `id` doubles as the row's `data-setting` address — for the `SettingsState` rows it IS the field
 * name, so a test or spec that knows the field knows the row.
 *
 * Two settings are NOT in `SettingsState`. GitHub sync (YAZ-1081 YAZ-1818) lives per-vault in
 * `.yaseendraw/github.json`, read and written through the engine, so its section is `available`
 * only when App hands the engine's status + setter over. The Pixabay API key (🔒 YAZ-1775 D4) lives in
 * main's owner-only `secrets.json` (YAZ-1842 D1) and is never in any renderer's state at all — its row writes
 * through `secrets:set` and reads back only "set" / "not set".
 */
import type { ReactNode } from 'react'
import type { GithubSyncStatus, SettingsState } from '@shared/types'
import type { VaultStorageState } from '../hooks/useVaultStorage'
import { CANVAS_SECTION } from './canvasSection'
import { Segmented } from './controls'
import { HOTKEY_GROUPS, type HotkeyEntry } from './hotkeys'
import { LibraryFolderControl, LibraryFolderHint } from './LibraryFolderControl'
import { DIAGRAM_DARK_COLORS_OPTIONS, ON_OFF_OPTIONS, repoHint, THEME_OPTIONS } from './options'
import { PixabayKeyControl } from './PixabayKeyControl'
import { STORAGE_SECTION } from './storageSection'
import { SHARING_SECTION } from '../share/SharingPage'
import type { SharingState } from '../share/useSharing'

export interface SettingsCtx {
  settings: SettingsState
  onChange: (next: SettingsState) => void
  sync?: { status: GithubSyncStatus | null; setEnabled: (enabled: boolean) => void }
  /** Settings › Storage (YAZ-1801): App's `useVaultStorage`; undefined with no vault open, which hides the section. */
  storage?: VaultStorageState
  /** Settings › Sharing (YAZ-1799 D7): App's `useSharing`; undefined hides the section. */
  sharing?: SharingState
}

export interface SettingDef {
  id: string
  label: string
  /** Shown under the label; a hint written as a function reads live state (the sync repo facts). */
  hint?: string | ((ctx: SettingsCtx) => string)
  keywords?: readonly string[]
  /** The control stacks full-width under the text instead of sitting beside it (D7). */
  wide?: boolean
  /**
   * No text column at all: the control IS the row, full-width (YAZ-1801 — Settings › Storage's
   * lists and its one action, which carry their own words). The label and hint still feed search.
   */
  bare?: true
  render: (ctx: SettingsCtx) => ReactNode
}

export type SettingsSectionId = 'appearance' | 'canvas' | 'files' | 'images' | 'sync' | 'storage' | 'sharing' | 'hotkeys'

/** Rows that belong together under one sub-heading; no title = plain rows straight under the section. */
export interface SettingsGroup {
  title?: string
  hint?: string
  /** A group that only exists while it has something to say (YAZ-1801's "Needs attention"); absent = always. Search follows it. */
  available?: (ctx: SettingsCtx) => boolean
  items: readonly SettingDef[]
}

export interface SettingsSection {
  id: SettingsSectionId
  title: string
  /** A section that only exists in some contexts (sync needs the engine); absent = always. */
  available?: (ctx: SettingsCtx) => boolean
  /** One line under the section title, for the section whose settings do not live where the rest do. */
  note?: string
  /**
   * Its own page in the dialog rather than a stretch of the scrolling settings page — the
   * hotkey reference, which is a table to look things up in, not settings to scroll past.
   * Search still indexes it.
   */
  standalone?: true
  groups: readonly SettingsGroup[]
}

/** One hotkey table (the Hotkeys section is one group per table, YAZ-1679 redesign). */
const hotkeyTable = (entries: readonly HotkeyEntry[]) => (
  <dl className="hotkeys__list">
    {entries.map(({ keys, label }) => (
      <div key={keys} className="hotkeys__row">
        <dt className="hotkeys__keys">{keys}</dt>
        <dd className="hotkeys__label">{label}</dd>
      </div>
    ))}
  </dl>
)

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'appearance',
    title: 'Appearance',
    groups: [
      {
        items: [
          {
            id: 'theme',
            label: 'Theme',
            keywords: ['dark', 'light', 'system'],
            render: ({ settings, onChange }) => <Segmented options={THEME_OPTIONS} value={settings.theme} onChange={(theme) => onChange({ ...settings, theme })} ariaLabel="Theme" />,
          },
          {
            // 🔒 YAZ-1802 D16: the default for every diagram; a file that sets its own `adaptiveColors` keeps it.
            id: 'diagramDarkColors',
            label: 'draw.io diagrams in dark mode',
            hint: 'Adapt re-colours diagrams so they stay readable in dark mode. A diagram that asks to keep its own colours always does.',
            keywords: ['drawio', 'draw.io', 'diagram', 'dark', 'colors', 'colours', 'adaptive'],
            render: ({ settings, onChange }) => (
              <Segmented options={DIAGRAM_DARK_COLORS_OPTIONS} value={settings.diagramDarkColors} onChange={(diagramDarkColors) => onChange({ ...settings, diagramDarkColors })} ariaLabel="draw.io diagrams in dark mode" />
            ),
          },
        ],
      },
    ],
  },
  // 🔒 YAZ-1775 D9: the user-level canvas preferences, declared in their own module because there are
  // fourteen of them and they are the one section with a mapping behind it (`shared/canvasPrefs.ts`).
  CANVAS_SECTION,
  {
    id: 'files',
    title: 'Files',
    groups: [
      {
        items: [
          {
            // GRO-2272: the confirm sheet is the ONLY guard on delete (the OS Trash has no
            // programmatic undo), so this defaults ON and the hint says what turning it off
            // actually means rather than being a bare switch.
            id: 'confirmDelete',
            label: 'Confirm before deleting',
            hint: 'Deleted files and folders move to the Trash either way.',
            render: ({ settings, onChange }) => (
              <Segmented options={ON_OFF_OPTIONS} value={settings.confirmDelete} onChange={(confirmDelete) => onChange({ ...settings, confirmDelete })} ariaLabel="Confirm before deleting" />
            ),
          },
          {
            // YAZ-1800: the sidebar's hover preview; the picture button in the sidebar header toggles the same flag.
            id: 'hoverPreview',
            label: 'Preview on hover',
            hint: 'Rest the mouse on a board in the sidebar to see the whole board.',
            render: ({ settings, onChange }) => (
              <Segmented options={ON_OFF_OPTIONS} value={settings.hoverPreview} onChange={(hoverPreview) => onChange({ ...settings, hoverPreview })} ariaLabel="Preview on hover" />
            ),
          },
          {
            // 🔒 YAZ-1775 D5: ONE library folder for every vault. `wide` because the row's real content is
            // the resolved path, which is long, and the two buttons belong under it rather than
            // squeezed beside it. The hint is a component: only main can resolve the default.
            id: 'libraryFolder',
            label: 'Library folder',
            hint: 'Your saved components and media favorites, shared by every vault. Put it inside a synced vault to back it up.',
            keywords: ['library', 'components', 'favorites', 'media', 'folder'],
            wide: true,
            render: ({ settings, onChange }) => (
              <>
                <LibraryFolderHint setting={settings.libraryFolder} />
                <div className="settings__options" role="group" aria-label="Library folder">
                  <LibraryFolderControl settings={settings} onChange={onChange} />
                </div>
              </>
            ),
          },
        ],
      },
    ],
  },
  {
    id: 'images',
    title: 'Images',
    groups: [
      {
        items: [
          {
            // 🔒 YAZ-1775 D4: the key is typed here once, kept by main, and never shown again. Its id is
            // not a `SettingsState` field — the state file is broadcast to every window, and a key
            // in it would be a key in every devtools console.
            id: 'pixabayApiKey',
            label: 'Pixabay API key',
            hint: 'Stored in this app\'s data folder, readable only by your user, and never shown again. Iconify needs no key.',
            keywords: ['pixabay', 'api key', 'iconify', 'photos', 'icons', 'image studio', 'secret'],
            wide: true,
            render: () => <PixabayKeyControl />,
          },
        ],
      },
    ],
  },
  {
    id: 'sync',
    title: 'Sync',
    available: (ctx) => ctx.sync !== undefined,
    note: "These settings are saved in this vault's .yaseendraw folder, not app-wide. Sync commits boards only: Excalidraw drawings, draw.io diagrams, their pictures in assets/, and .yaseendraw/. Anything else in the repo is left for you to commit.",
    groups: [
      {
        items: [
          {
            id: 'githubSync',
            label: 'Sync this vault to GitHub',
            hint: ({ sync }) => repoHint(sync?.status ?? null),
            keywords: ['repo', 'remote'],
            // `status.enabled` is the switch's honest read-back, stamped by the engine — NOT
            // `state`, which is `off` for a vault that is enabled but has no repo or remote yet (the
            // hint explains those). A null status — first fetch still in flight — reads as Off, the
            // safe default. `sync` is defined here: the section is `available` only with it.
            render: ({ sync }) => <Segmented options={ON_OFF_OPTIONS} value={sync?.status?.enabled === true} onChange={(enabled) => sync?.setEnabled(enabled)} ariaLabel="Sync this vault to GitHub" />,
          },
        ],
      },
    ],
  },
  // YAZ-1801: what this vault weighs against GitHub's limits, and "Move pictures out of boards".
  STORAGE_SECTION,
  // YAZ-1799 D7: set up Cloudflare sharing, this vault's shared boards, a custom domain, turning it off.
  SHARING_SECTION,
  {
    id: 'hotkeys',
    title: 'Hotkeys',
    standalone: true,
    // One group per table, so "Window" is a heading search knows. The id is the table's own
    // (`hotkeys-window`); every key and label of the table is a keyword, so "close tab" or "⌘W"
    // finds it, and "keyboard shortcuts" reaches every table.
    groups: HOTKEY_GROUPS.map(({ id, title, entries }) => ({
      title,
      items: [
        {
          id: `hotkeys-${id}`,
          label: `${title} shortcuts`,
          keywords: ['keyboard shortcuts', ...entries.flatMap((entry) => [entry.keys, entry.label])],
          wide: true,
          render: () => hotkeyTable(entries),
        },
      ],
    })),
  },
]

/** The sections this context can show, in registry order — what the nav lists and search covers. */
export const availableSections = (ctx: SettingsCtx): SettingsSection[] => SETTINGS_SECTIONS.filter((section) => section.available?.(ctx) ?? true)

/** A hint resolved against the context: plain text, or the live-state kind. */
export const resolveHint = (item: SettingDef, ctx: SettingsCtx): string | undefined => (typeof item.hint === 'function' ? item.hint(ctx) : item.hint)

/** The groups of a section this context can show. */
export const availableGroups = (section: SettingsSection, ctx: SettingsCtx): SettingsGroup[] => section.groups.filter((group) => group.available?.(ctx) ?? true)

/** Whether the row stacks its control. */
export const resolveWide = (item: SettingDef): boolean => item.wide === true
