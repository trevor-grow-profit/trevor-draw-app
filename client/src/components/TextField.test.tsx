/**
 * The one-edit text field (YAZ-2056 D3, ported from Docs `views/view/TextField.tsx`): Enter or blur
 * commits once, Escape restores, `normalize` runs before the comparison, and `selectOnMount`
 * selects the whole value so typing replaces it (Docs YAZ-1974 D5).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TextField } from './TextField'

let root: Root | null = null
let container: HTMLElement | null = null

function mount(normalize: (draft: string) => string, selectOnMount?: boolean) {
  const onCommit = vi.fn()
  const onDone = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(<TextField aria-label="Value" value="Notes" normalize={normalize} onCommit={onCommit} onDone={onDone} autoFocus selectOnMount={selectOnMount} />))
  const input = container.querySelector<HTMLInputElement>('[aria-label="Value"]')
  if (input === null) throw new Error('missing input')
  return { input, onCommit, onDone }
}

function setValue(input: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function press(input: HTMLInputElement, key: string): void {
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
}

function blur(input: HTMLInputElement): void {
  act(() => {
    input.focus()
    input.blur()
  })
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
})

describe('TextField normalization', () => {
  it('normalizes before comparison and visibly keeps a valid normalized draft even when unchanged', () => {
    const { input, onCommit } = mount((draft) => draft.trim())
    setValue(input, ' Notes ')
    press(input, 'Enter')
    expect(input.value).toBe('Notes')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('Escape bypasses normalization and restores, then a later edit still commits', () => {
    const normalize = vi.fn((draft: string) => draft.trim())
    const { input, onCommit } = mount(normalize)
    setValue(input, 'Archive')
    press(input, 'Escape')
    expect(input.value).toBe('Notes')
    expect(normalize).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()

    setValue(input, 'Wiki')
    press(input, 'Enter')
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Wiki')
  })

  it('deduplicates Enter followed by blur', () => {
    const { input, onCommit, onDone } = mount((draft) => draft)
    setValue(input, 'Wiki')
    press(input, 'Enter')
    blur(input)
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('Wiki')
    expect(onDone).toHaveBeenCalledTimes(1)
  })
})

describe('TextField selectOnMount', () => {
  it('selectOnMount selects the whole value, so typing replaces it (Docs YAZ-1974 D5); without it nothing is selected', () => {
    const { input } = mount((draft) => draft, true)
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5])
    act(() => root?.unmount())
    container?.remove()
    const plain = mount((draft) => draft).input
    expect(plain.selectionEnd! - plain.selectionStart!).toBe(0)
  })
})
