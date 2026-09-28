/**
 * SETTINGS › CANVAS (🔒 YAZ-1775 D9): one row per `CanvasPrefs` key, writing the whole
 * `SettingsState` with only `canvas` changed — the same store the rail's Writing / Frames toggles
 * and the engine's own read-back write, so the three can never disagree about a value. There is
 * no second door: 🔒 YAZ-1775 D10 removed the canvas hamburger's Preferences submenu, and this is the only
 * UI these preferences have.
 *
 * Row ids are `canvas.<key>` — the registry's "the id names the field" rule, one level down, so a
 * spec that knows the field knows the row.
 *
 * WHICH CONTROL: the booleans are the settings' Off/On segmented pair; Select on, Sloppiness and
 * Text alignment are short vocabularies and stay segmented; Default font is a long list and so is
 * a `<select>` (the controls module's rule). The two pen widths are number fields that commit on
 * change and simply ignore anything that is not a width the engine could draw with.
 *
 * NOT HERE, ON PURPOSE: the properties-toolbar pref, removed by the round-4 amendment — the
 * toolbar mode is a constant (`YASEEN_FULL_TOOLBAR_MODE`), not a choice. Canvas background is not
 * here either: it is per BOARD, written into the file by the engine, so it lives in View ›
 * Canvas Background (🔒 YAZ-1775 D10). Theme is Appearance's only row. Nor are the laser's trail,
 * colour and size (🔒 YAZ-1989 D1): they are `CanvasPrefs` so they are remembered and follow every
 * window, but the laser's own toolbar in the engine is the one place they are changed.
 */
import type { ReactNode } from 'react'
import { DEFAULT_CANVAS_PREFS, FONT_FAMILY_OPTIONS, type CanvasPrefs, type Roughness, type SelectOn, type SettingsState, type TextAlign } from '@shared/types'
import { Segmented, Select } from './controls'
import { ON_OFF_OPTIONS, type Option } from './options'
import type { SettingDef, SettingsSection } from './registry'

const SELECT_ON_OPTIONS: readonly Option<SelectOn>[] = [
  { value: 'wrap', label: 'Wrap' },
  { value: 'overlap', label: 'Overlap' },
]
const FONT_OPTIONS: readonly Option<number>[] = FONT_FAMILY_OPTIONS.map(({ id, label }) => ({ value: id, label }))
/** The engine's `ROUGHNESS` presets, in its own order and with its own names. */
const ROUGHNESS_OPTIONS: readonly Option<Roughness>[] = [
  { value: 0, label: 'Architect' },
  { value: 1, label: 'Artist' },
  { value: 2, label: 'Cartoonist' },
]
const TEXT_ALIGN_OPTIONS: readonly Option<TextAlign>[] = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
]

type BoolKey = { [K in keyof CanvasPrefs]: CanvasPrefs[K] extends boolean ? K : never }[keyof CanvasPrefs]
type WidthKey = 'writingStrokeWidth' | 'vectorStrokeWidth'

const write = (settings: SettingsState, patch: Partial<CanvasPrefs>): SettingsState => ({ ...settings, canvas: { ...settings.canvas, ...patch } })

const toggle = (key: BoolKey, label: string, hint?: string, keywords?: readonly string[]): SettingDef => ({
  id: `canvas.${key}`,
  label,
  hint,
  keywords,
  render: ({ settings, onChange }) => <Segmented options={ON_OFF_OPTIONS} value={settings.canvas[key]} onChange={(value) => onChange(write(settings, { [key]: value }))} ariaLabel={label} />,
})

/**
 * A width field, keyed by its value so a change arriving from another window (or from the engine)
 * remounts it with the new number instead of fighting what is being typed.
 */
function WidthField({ value, label, onCommit }: { value: number; label: string; onCommit: (next: number) => void }): ReactNode {
  return (
    <input
      type="number"
      className="settings__input settings__input--number"
      aria-label={label}
      min={0.1}
      max={100}
      step={0.1}
      defaultValue={value}
      key={value}
      onChange={(e) => {
        const next = Number(e.target.value)
        if (Number.isFinite(next) && next > 0 && next <= 100 && next !== value) onCommit(next)
      }}
    />
  )
}

const width = (key: WidthKey, label: string, hint: string): SettingDef => ({
  id: `canvas.${key}`,
  label,
  hint,
  keywords: ['pen', 'stroke', 'width'],
  render: ({ settings, onChange }) => <WidthField value={settings.canvas[key]} label={label} onCommit={(next) => onChange(write(settings, { [key]: next }))} />,
})

export const CANVAS_SECTION: SettingsSection = {
  id: 'canvas',
  // 🔒 YAZ-1802 D12 / D13: these preferences are Excalidraw's alone; a draw.io diagram has fixed defaults.
  title: 'Excalidraw canvas',
  groups: [
    {
      title: 'Drawing aids',
      hint: 'Applies to every Excalidraw drawing, in every window.',
      items: [
        toggle('gridModeEnabled', 'Grid', undefined, ['grid mode']),
        toggle('objectsSnapModeEnabled', 'Snap to objects', undefined, ['snapping']),
        toggle('snapToMidpoints', 'Snap to midpoints', undefined, ['snapping', 'midpoint']),
        toggle('arrowBinding', 'Arrow binding', 'Arrows attach to the shapes they touch.', ['bind']),
        {
          id: 'canvas.selectOn',
          label: 'Select on',
          hint: 'Wrap selects only what the box fully encloses; Overlap selects anything it touches.',
          keywords: ['box selection', 'contain', 'overlap'],
          render: ({ settings, onChange }) => <Segmented options={SELECT_ON_OPTIONS} value={settings.canvas.selectOn} onChange={(selectOn) => onChange(write(settings, { selectOn }))} ariaLabel="Select on" />,
        },
      ],
    },
    {
      title: 'Modes',
      items: [
        toggle('toolLock', 'Tool lock', 'Keep the chosen tool after drawing with it.', ['keep tool']),
        toggle('zenModeEnabled', 'Zen mode', undefined, ['zen']),
        toggle('writingMode', 'Writing mode', 'The Writing toggle on the canvas rail is this same setting.', ['handwriting', 'pen']),
        toggle('framesVisible', 'Show frames', 'The frame outline and its name; frames still clip their contents when hidden.', ['frame']),
      ],
    },
    {
      title: 'New elements',
      hint: 'What a shape or a line is born with; the toolbar still changes anything you have selected.',
      items: [
        width('writingStrokeWidth', 'Writing pen width', `Default ${DEFAULT_CANVAS_PREFS.writingStrokeWidth}.`),
        width('vectorStrokeWidth', 'Vector stroke width', `Default ${DEFAULT_CANVAS_PREFS.vectorStrokeWidth}.`),
        {
          id: 'canvas.defaultFontFamily',
          label: 'Default font',
          hint: 'The font new text is born with.',
          keywords: ['font family', 'assistant', 'excalifont'],
          render: ({ settings, onChange }) => <Select options={FONT_OPTIONS} value={settings.canvas.defaultFontFamily} onChange={(defaultFontFamily) => onChange(write(settings, { defaultFontFamily }))} ariaLabel="Default font" />,
        },
        {
          id: 'canvas.defaultRoughness',
          label: 'Default sloppiness',
          hint: 'How hand-drawn new shapes look.',
          keywords: ['roughness', 'architect', 'artist', 'cartoonist'],
          render: ({ settings, onChange }) => (
            <Segmented options={ROUGHNESS_OPTIONS} value={settings.canvas.defaultRoughness} onChange={(defaultRoughness) => onChange(write(settings, { defaultRoughness }))} ariaLabel="Default sloppiness" />
          ),
        },
        {
          id: 'canvas.defaultTextAlign',
          label: 'Default text alignment',
          keywords: ['text align', 'center'],
          render: ({ settings, onChange }) => (
            <Segmented options={TEXT_ALIGN_OPTIONS} value={settings.canvas.defaultTextAlign} onChange={(defaultTextAlign) => onChange(write(settings, { defaultTextAlign }))} ariaLabel="Default text alignment" />
          ),
        },
      ],
    },
  ],
}
