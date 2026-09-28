/**
 * The sidebar's inline create box. Since YAZ-1604 it can start with a SEED (`09_14- `): the seed
 * is shown as the value with the caret at its end, and Enter on the untouched seed is a no-op —
 * the box stays open — so a bare date folder is never born by accident (🔒 YAZ-1604 D3).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CreateInline } from './CreateInline'
import type { EntryKind } from './createEntry'


let root: Root | null = null
let container: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
})

function mount(seed?: string, kind: EntryKind = 'dir') {
  const onSubmit = vi.fn(() => Promise.resolve())
  const onCancel = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(<CreateInline kind={kind} seed={seed} indent={0} onSubmit={onSubmit} onCancel={onCancel} />))
  const field = container.querySelector<HTMLInputElement>('.create-inline__input')
  if (field === null) throw new Error('the create input did not mount')
  return { field, onSubmit }
}

const enter = (field: HTMLInputElement) => act(() => void field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))

describe('CreateInline seed (YAZ-1604)', () => {
  it('mounts empty with the placeholder when no seed is given — the pre-YAZ-1604 box, unchanged', () => {
    const { field } = mount()
    expect(document.activeElement).toBe(field)
    expect(field.value).toBe('')
    expect(field.placeholder).toBe('New folder')
  })

  it.each([
    ['drawing', 'New Excalidraw drawing'],
    ['diagram', 'New draw.io diagram'],
  ] as const)('a %s box names what it makes in its placeholder (🔒 YAZ-1999 D6)', (kind, placeholder) => {
    expect(mount(undefined, kind).field.placeholder).toBe(placeholder)
  })

  it('shows the seed with the caret at its end, right after the dash', () => {
    const { field } = mount('06_22- ')
    expect(document.activeElement).toBe(field)
    expect(field.value).toBe('06_22- ')
    expect(field.selectionStart).toBe(7)
    expect(field.selectionEnd).toBe(7)
  })

  it('Enter on the untouched seed is a no-op; Enter after a title submits the trimmed name', async () => {
    const { field, onSubmit } = mount('06_22- ')
    await enter(field)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(container?.querySelector('.create-inline__input')).not.toBeNull()
    field.value = '06_22- Launch '
    await enter(field)
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('06_22- Launch')
  })
})
