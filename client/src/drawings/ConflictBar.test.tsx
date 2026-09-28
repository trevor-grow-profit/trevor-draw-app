/**
 * The "File changed on disk" bar (🔒 YAZ-1810), shared by both document hosts: the one guard between
 * an outside change and a dirty tab, so each button must reach exactly its own handler.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ConflictBar } from './ConflictBar'

let root: Root | null = null
let container: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
})

function mount() {
  const onReload = vi.fn()
  const onKeepMine = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(<ConflictBar onReload={onReload} onKeepMine={onKeepMine} />))
  const button = (name: string) => [...container!.querySelectorAll('button')].find((b) => b.textContent === name)!
  return { bar: container.querySelector<HTMLElement>('.conflict-bar')!, button, onReload, onKeepMine }
}

describe('ConflictBar', () => {
  it('is an alert that says what happened and offers the two answers', () => {
    const { bar } = mount()
    expect(bar.getAttribute('role')).toBe('alert')
    expect(bar.querySelector('span')?.textContent).toBe('File changed on disk.')
    expect([...bar.querySelectorAll('button')].map((b) => [b.textContent, b.type])).toEqual([
      ['Reload', 'button'],
      ['Keep mine', 'button'],
    ])
  })

  it('Reload takes the disk version and nothing else', () => {
    const { button, onReload, onKeepMine } = mount()
    act(() => button('Reload').click())
    expect(onReload).toHaveBeenCalledOnce()
    expect(onKeepMine).not.toHaveBeenCalled()
  })

  it("Keep mine keeps the tab's version and nothing else", () => {
    const { button, onReload, onKeepMine } = mount()
    act(() => button('Keep mine').click())
    expect(onKeepMine).toHaveBeenCalledOnce()
    expect(onReload).not.toHaveBeenCalled()
  })
})
