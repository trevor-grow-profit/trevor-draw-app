/**
 * MENU → THE VISIBLE BOARD (🔒 YAZ-1775 D10), and the one test for "is this tab in front".
 *
 * WHY A DOM EVENT AND NOT A PROP: the shell keeps several tabs MOUNTED at once — all but the
 * active one are `visibility: hidden` layers, each with its own live engine — so a prop, a
 * context or a `window` listener would reach every one of them and the wrong canvas would answer.
 * A CustomEvent dispatched on the visible layer's `.editor--drawing` section reaches exactly one
 * host. It is the reason `handleKeyboardGlobally` is the parity list's one deliberate drop.
 *
 * A draw.io diagram's `.editor--diagram` section takes the same event (🔒 YAZ-1802 D9): of the
 * three commands, main enables only Export Image… on a diagram tab.
 */

export const BOARD_COMMAND_EVENT = 'yaseendraw:board-command'

export type BoardCommand = { kind: 'export-image' } | { kind: 'export-drawing' } | { kind: 'canvas-background'; color: string }

/** THE test: `el` is in the tab layer that is in front (an element outside any layer counts as in front). */
export function isFrontmost(el: Element | null): boolean {
  return el !== null && el.closest('.tabstack__layer--hidden') === null
}

/** The workspace's VISIBLE board section, if the active tab is a drawing or a diagram. */
export function activeBoardSection(root: ParentNode = document): Element | null {
  return [...root.querySelectorAll('.tabstack__layer .editor--drawing, .tabstack__layer .editor--diagram')].find(isFrontmost) ?? null
}

/**
 * Dispatches `command` to the visible board; true when one was there to take it. Main already
 * greys each menu item out off a board it does not work for — this is the belt to that pair of braces.
 */
export function requestBoardCommand(command: BoardCommand, root: ParentNode = document): boolean {
  const section = activeBoardSection(root)
  if (section === null) return false
  section.dispatchEvent(new CustomEvent<BoardCommand>(BOARD_COMMAND_EVENT, { detail: command, bubbles: false }))
  return true
}
