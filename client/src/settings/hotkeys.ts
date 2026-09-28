/**
 * Hotkey reference (GRO-2067 Q4; a Settings page since YAZ-1679): the single source-of-truth list
 * every binding is read from — Settings › Hotkeys renders it, and the settings search indexes every
 * label and key so "close tab" finds the page. When a keymap changes anywhere (lib/sidebarHotkey.ts,
 * lib/fileClipboardHotkey.ts, the application menu in desktop/src/main/menu.ts, the canvas's own
 * handlers in client/src/drawings/, draw.io's keymap in client/src/diagrams/drawioProtocol.ts and
 * desktop/drawio-overlay/js/PostConfig.js), update WINDOW_HOTKEYS, CANVAS_HOTKEYS, DRAWIO_HOTKEYS
 * or MOUSE_TIPS with it — hotkeys.test.ts pins the expected set so drift fails loudly.
 */
export interface HotkeyEntry {
  keys: string
  label: string
}

/** App/window shortcuts: menu-owned B3/Tabs/⌘K/⌘,/zoom (YAZ-1679, YAZ-1710), renderer-owned ⌘B (YAZ-1280) and the sidebar's ⌘X / ⌘C / ⌘V (YAZ-1674), plus Open Recent's open-beside gesture. */
export const WINDOW_HOTKEYS: readonly HotkeyEntry[] = [
  { keys: '⌘⇧N', label: 'New window — same folder and tabs' },
  { keys: '⌘⇧O', label: 'Open folder…' },
  // The vault switcher (YAZ-1767 D8): the sidebar header's panel, keyboard-first like ⌘K's bar.
  { keys: '⌘O', label: 'Switch vault (type to filter, ⏎ brings it to the front or opens a new window, ⇧⏎ opens it in this window)' },
  { keys: '⌘K', label: 'Search the vault' },
  { keys: '⌘,', label: 'Settings' },
  { keys: '⌘B', label: 'Toggle sidebar outside editing surfaces' },
  // View › Zoom (YAZ-1710): main applies the step to the focused window itself, so it is the
  // whole app that zooms — there is no per-document zoom.
  { keys: '⌘+ / ⌘− / ⌘0', label: 'Zoom the app in / out / back to 100%' },
  // The file clipboard (YAZ-1674, D6): the sidebar's own chords, about the selection. One
  // clipboard for every window, so a copy here pastes into another vault's window.
  { keys: '⌘X / ⌘C', label: 'Cut / copy the selected files and folders — pastes in any window, on any vault' },
  { keys: '⌘V', label: 'Paste beside the first selected row — into a folder, next to a file, or into the vault root with none' },
  { keys: '⌘W', label: 'Close tab — on the last tab it empties the window, then closes it' },
  { keys: '⌘⇧W', label: 'Close window' },
  { keys: '⌃Tab / ⌃⇧Tab', label: 'Next / previous tab' },
  { keys: '⌘⇧] / ⌘⇧[', label: 'Next / previous tab' },
  { keys: '⌥ Open Recent', label: '⌥-click a recent folder to open it in a new window' },
]

/**
 * The shortcuts that only mean something with a DRAWING in front (YAZ-1812). ⌘⇧E and ⌘⇧S are
 * the application menu's (🔒 YAZ-1775 D10, 🔒 YAZ-1775 D3) and grey out on any other tab;
 * ⌘S, ⌘F and ⌘C are bound on the drawing's own element in the capture phase and suppressed
 * whenever the keystroke could have meant something else — which is why ⌘C still copies a selection.
 */
export const CANVAS_HOTKEYS: readonly HotkeyEntry[] = [
  { keys: '⌘⇧E', label: "Export image… — the engine's own PNG / SVG dialog" },
  { keys: '⌘⇧S', label: 'Export Excalidraw drawing… — write a standalone .excalidraw with its images embedded' },
  // Autosave already runs on a 500 ms timer, so this is "write it NOW" (🔒 YAZ-1810).
  { keys: '⌘S', label: 'Save the drawing in front now — it autosaves anyway' },
  { keys: '⌘F', label: 'Open the Images tab of the canvas panel' },
  { keys: '⌘C', label: 'Open the Components tab of the canvas panel — when nothing is selected and no text is being edited' },
]

/**
 * A draw.io diagram in front (🔒 YAZ-1802 D12b): Yasin's Excalidraw keys, mapped onto draw.io. With
 * nothing selected a letter is a tool; with a selection the same letters colour it, the fork's way.
 * ⌘B / ⌘U / ⌘S are draw.io's own, ⌘B passing to the sidebar when nothing is selected.
 */
export const DRAWIO_HOTKEYS: readonly HotkeyEntry[] = [
  { keys: 'R / O / T', label: 'Rectangle / ellipse / text — with nothing selected' },
  { keys: 'A / D / L', label: 'Arrow / line — with nothing selected' },
  { keys: 'W / P / X', label: 'Freehand pen — with nothing selected' },
  {
    keys: 'T B W D R P A V U C E G Y O N',
    label: "Colour the selection (transparent, black, white, gray, red, pink, grape, violet, blue, cyan, teal, green, yellow, orange, bronze) — a shape's fill, a text's colour, a line's stroke, an image's border",
  },
  { keys: '⇧ + colour letter', label: "A shape's outline, a text's background" },
  { keys: '1 … 9, 0', label: 'Size the selection — text 12 to 128, anything else 48 to 1024 on its long side' },
  { keys: '⌘\\', label: 'Clear formatting' },
  { keys: '⌘⇧X', label: 'Strikethrough' },
  { keys: '⌘B / ⌘U', label: 'Bold / underline — ⌘B with nothing selected toggles the sidebar' },
  // draw.io's own save event, which the host turns into "write it NOW" (🔒 YAZ-1802 D6).
  { keys: '⌘S', label: 'Save the diagram in front now — it autosaves anyway' },
  { keys: '⌘-scroll / pinch', label: 'Zoom — a plain scroll pans' },
  { keys: 'Right-click empty canvas', label: 'Grid on / off' },
]

export const MOUSE_TIPS: readonly HotkeyEntry[] = [
  { keys: '⌘-click file', label: 'Open it in a background tab' },
  // The multi-select gesture (YAZ-1336 🔒 YAZ-1775 D2, folders too since YAZ-1578) and what it is FOR
  // (YAZ-1337): the two plural menu items. Shift toggles one row at a time — it never opens
  // anything and never folds a folder.
  { keys: '⇧-click file or folder', label: 'Add or remove it from a multi-selection — right-click for Copy N paths / Open N in new tabs' },
  { keys: 'Right-click file', label: 'Cut / Copy / Paste, Copy path, New Excalidraw drawing / New draw.io diagram, Open in ▸ (new window, VS Code, default app, Finder)' },
  // The vault menu (YAZ-1941, ported from Docs YAZ-1798): the sidebar header's vault name, or any vault in the ⌘O switcher.
  { keys: 'Right-click vault', label: 'Open in this window, Set display name, Copy vault name / path, Reveal in Finder, VS Code, Remove from recents' },
]

/**
 * The groups as Settings › Hotkeys shows them, heading first — one place to add another. `id` names
 * the group's settings row (`hotkeys-<id>`), so a title can say "draw.io" without the id carrying a dot.
 */
export const HOTKEY_GROUPS: readonly { id: string; title: string; entries: readonly HotkeyEntry[] }[] = [
  { id: 'window', title: 'Window', entries: WINDOW_HOTKEYS },
  { id: 'canvas', title: 'Excalidraw canvas', entries: CANVAS_HOTKEYS },
  { id: 'drawio', title: 'draw.io diagram', entries: DRAWIO_HOTKEYS },
  { id: 'mouse', title: 'Mouse', entries: MOUSE_TIPS },
]
