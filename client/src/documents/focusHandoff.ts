/**
 * Focus handoff on tab reveal (🔒 decided on YAZ-1812, built in YAZ-1815).
 *
 * The canvas has `autoFocus`, which is safe on a background tab — a hidden layer is
 * `visibility: hidden` and Chromium will not focus into one — but it fires only at MOUNT. Switch
 * to an ALREADY-mounted tab and nothing holds the keyboard, so the first `r` or `o` goes nowhere
 * until the user clicks the canvas. The reveal effect that re-measures the canvas is exactly the
 * moment to hand focus over — GATED, because the same moment can arrive while the ⌘K search bar,
 * the vault switcher or a dialog has the keyboard, and stealing it there would break the very
 * gesture the user is in the middle of. The rule: focus moves only when nothing outside the tab
 * layer holds it.
 */

/**
 * May the canvas that just became visible take the keyboard?
 *
 * Yes when NOTHING has claimed it (`document.activeElement` is null, or the body — what a browser
 * reports when no element is focused), or when what holds it is inside the tab layer: the tab
 * being left, or this one. No otherwise — chrome outside the layer (the sidebar's search bar, the
 * vault switcher, the settings dialog, the tab strip) keeps what it has.
 */
export function mayTakeFocus(active: Element | null, layer: Element | null): boolean {
  if (active === null || active === active.ownerDocument.body) return true
  return layer !== null && layer.contains(active)
}
