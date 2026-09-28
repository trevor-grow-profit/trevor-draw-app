import { describe, expect, it } from 'vitest'
import { CANVAS_HOTKEYS, DRAWIO_HOTKEYS, HOTKEY_GROUPS, MOUSE_TIPS, WINDOW_HOTKEYS } from './hotkeys'

describe('HOTKEYS source of truth', () => {
  it('covers the window & tab shortcuts from the application menu (B3 + Tabs + View › Zoom) plus the open-beside tip', () => {
    const keys = WINDOW_HOTKEYS.map((h) => h.keys)
    // ⌘⇧N / ⌘⇧O / ⌘W (Close Tab) / ⌘⇧W (Close Window), the tab-switch pairs and the zoom trio
    // live in the menu (menu.ts, GRO-2161/2232, YAZ-1710); ⌥-click Open Recent = open beside (GRO-2211).
    for (const expected of ['⌘⇧N', '⌘⇧O', '⌘O', '⌘K', '⌘,', '⌘B', '⌘+ / ⌘− / ⌘0', '⌘X / ⌘C', '⌘V', '⌘W', '⌘⇧W', '⌃Tab / ⌃⇧Tab', '⌘⇧] / ⌘⇧[', '⌥ Open Recent']) {
      expect(keys).toContain(expected)
    }
    expect(WINDOW_HOTKEYS.find((h) => h.keys === '⌘B')?.label).toMatch(/outside editing surfaces/i)
    // ⌘O (YAZ-1767 D8): the switcher's two verbs, filter then open — in a NEW window; only ⇧⏎ opens in place (Docs YAZ-1974 D8).
    expect(WINDOW_HOTKEYS.find((h) => h.keys === '⌘O')?.label).toMatch(/switch vault.*filter.*new window/i)
    expect(WINDOW_HOTKEYS.find((h) => h.keys === '⌘O')?.label).toMatch(/⇧⏎ opens it in this window/)
    // YAZ-1710: main applies the step to the whole window — there is no per-document zoom to name.
    expect(WINDOW_HOTKEYS.find((h) => h.keys === '⌘+ / ⌘− / ⌘0')?.label).toMatch(/the app/i)
    // The ⌘W ladder swap (GRO-2232, locked): ⌘W closes the TAB, ⌘⇧W the window — never the reverse.
    expect(WINDOW_HOTKEYS.find((h) => h.keys === '⌘W')?.label).toMatch(/close tab/i)
    expect(WINDOW_HOTKEYS.find((h) => h.keys === '⌘⇧W')?.label).toMatch(/close window/i)
  })

  it('the mouse tips carry the I3 click rulings: ⌘-click = background tab, right-click = new window', () => {
    const byKeys = (keys: string) => MOUSE_TIPS.find((t) => t.keys === keys)
    expect(byKeys('⌘-click file')?.label).toMatch(/background tab/i)
    expect(byKeys('Right-click file')?.label).toMatch(/new window/i)
    // The context menu's create group leads on the two board births (🔒 YAZ-1802 D13).
    expect(byKeys('Right-click file')?.label).toMatch(/New Excalidraw drawing \/ New draw\.io diagram/)
    // The vault menu (YAZ-1941): the one in-place open lives there, so the tip names it — and the display name (Docs YAZ-1974 D5).
    expect(byKeys('Right-click vault')?.label).toMatch(/Open in this window/)
    expect(byKeys('Right-click vault')?.label).toMatch(/Set display name/)
    // Multi-select (YAZ-1336 🔒 YAZ-1775 D2 → YAZ-1337): ⇧-click toggles rows, and the tip has to say what
    // that is FOR — the two plural items a right-click then offers.
    expect(byKeys('⇧-click file or folder')?.label).toMatch(/multi-selection/i)
    expect(byKeys('⇧-click file or folder')?.label).toMatch(/Copy N paths/)
    expect(byKeys('⇧-click file or folder')?.label).toMatch(/Open N in new tabs/)
  })

  /**
   * The old document layer is gone (YAZ-1808), and so is everything it bound: the outliner's
   * fold / zoom / mark chords, the folder-page view surface, wiki links, the right panel and the
   * ⌘⇧C copy-path chord. The reference may not advertise a key the app no longer answers. (⌘⇧X
   * came back as draw.io's strikethrough, 🔒 YAZ-1802 D12b, so it is no longer on the list.)
   */
  it('advertises NO binding of a deleted feature', () => {
    const all = HOTKEY_GROUPS.flatMap((group) => group.entries)
    for (const gone of ['⌘⇧U', '⌘⇧I', '⌘.', '⌘⇧.', '⌘⏎', '⌘U', '⌘⇧H', 'Tab / ⇧Tab', '⌘⇧C', '⌘⏎ / ⌥⏎', 'Click glyph', 'Click link', 'Click card']) {
      expect(all.map((h) => h.keys)).not.toContain(gone)
    }
    for (const word of [/bullet/i, /heading/i, /wiki/i, /right panel/i, /board card/i, /topic/i]) {
      expect(all.filter((h) => word.test(h.label))).toEqual([])
    }
  })

  it('is FOUR groups — Window, Excalidraw canvas, draw.io diagram and Mouse — in the order the page shows them', () => {
    expect(HOTKEY_GROUPS.map((g) => g.title)).toEqual(['Window', 'Excalidraw canvas', 'draw.io diagram', 'Mouse'])
    expect(HOTKEY_GROUPS.map((g) => g.id)).toEqual(['window', 'canvas', 'drawio', 'mouse'])
    expect(HOTKEY_GROUPS.map((g) => g.entries)).toEqual([WINDOW_HOTKEYS, CANVAS_HOTKEYS, DRAWIO_HOTKEYS, MOUSE_TIPS])
  })

  it('the draw.io table is the D12b keymap: tools with nothing selected, colour and size with a selection, and ⌘B’s split (🔒 YAZ-1802)', () => {
    expect(DRAWIO_HOTKEYS.map((h) => h.keys)).toEqual(['R / O / T', 'A / D / L', 'W / P / X', 'T B W D R P A V U C E G Y O N', '⇧ + colour letter', '1 … 9, 0', '⌘\\', '⌘⇧X', '⌘B / ⌘U', '⌘S', '⌘-scroll / pinch', 'Right-click empty canvas'])
    expect(DRAWIO_HOTKEYS.find((h) => h.keys === 'R / O / T')?.label).toMatch(/nothing selected/)
    expect(DRAWIO_HOTKEYS.find((h) => h.keys === '⇧ + colour letter')?.label).toMatch(/text's background/)
    expect(DRAWIO_HOTKEYS.find((h) => h.keys === '⌘B / ⌘U')?.label).toMatch(/nothing selected toggles the sidebar/)
  })

  it("the Canvas table carries every key that needs a drawing in front (YAZ-1812), and says what gates ⌘C", () => {
    // The menu's two drawing-only items (menu.ts) plus the three bound on the canvas host itself.
    expect(CANVAS_HOTKEYS.map((h) => h.keys)).toEqual(['⌘⇧E', '⌘⇧S', '⌘S', '⌘F', '⌘C'])
    expect(CANVAS_HOTKEYS.find((h) => h.keys === '⌘⇧E')?.label).toMatch(/export image/i)
    expect(CANVAS_HOTKEYS.find((h) => h.keys === '⌘⇧S')?.label).toMatch(/export excalidraw drawing/i)
    expect(CANVAS_HOTKEYS.find((h) => h.keys === '⌘S')?.label).toMatch(/autosaves/i)
    expect(CANVAS_HOTKEYS.find((h) => h.keys === '⌘C')?.label).toMatch(/nothing is selected/i)
  })

  it('every entry is renderable (non-empty keys and label) and free of the backtick-for-apostrophe typo', () => {
    for (const entry of HOTKEY_GROUPS.flatMap((group) => group.entries)) {
      expect(entry.keys.length).toBeGreaterThan(0)
      expect(entry.label.length).toBeGreaterThan(0)
      expect(entry.label).not.toContain('`')
    }
  })
})
