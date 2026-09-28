/**
 * The per-tab save chip (🔒 YAZ-1810): one label and one state class per autosave status —
 * `statusChips.css` colours the dot by that class — in a polite live region.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { SaveStatus } from '../lib/autosave'
import { SaveIndicator } from './SaveIndicator'

let root: Root | null = null
let container: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
})

function mount(status: SaveStatus): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(<SaveIndicator status={status} />))
  return container.querySelector<HTMLElement>('.save-indicator')!
}

describe('SaveIndicator', () => {
  it.each<[SaveStatus, string]>([
    ['saved', 'Saved'],
    ['unsaved', 'Unsaved'],
    ['saving', 'Saving…'],
    ['error', 'Save failed'],
  ])('%s reads "%s" and carries its state class', (status, label) => {
    const chip = mount(status)
    expect(chip.textContent).toBe(label)
    expect(chip.className).toBe(`save-indicator save-indicator--${status}`)
    expect(chip.querySelector('.save-indicator__dot')).not.toBeNull()
  })

  it('announces changes politely, as news the user did not ask for', () => {
    const chip = mount('saving')
    expect(chip.getAttribute('role')).toBe('status')
    expect(chip.getAttribute('aria-live')).toBe('polite')
  })
})
