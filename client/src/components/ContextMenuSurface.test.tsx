/**
 * The shared surface's two sizing props (YAZ-2056 D2): `width` is a fixed width — the Info popover
 * and the Share menu — and `minWidth` a floor the vault switcher grows past to fit its names
 * (Docs YAZ-1974 D7). Docs renamed `width` to `minWidth`; Draw keeps both.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ContextMenuSurface } from './ContextMenuSurface'

let root: Root | null = null
let container: HTMLElement | null = null

function mount(size: { width?: number; minWidth?: number }): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(<ContextMenuSurface x={0} y={0} onClose={() => undefined} {...size}>item</ContextMenuSurface>))
  return container.querySelector<HTMLElement>('.ctx-menu')!
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
})

describe('ContextMenuSurface sizing (YAZ-2056 D2)', () => {
  it('width is a fixed width, no floor', () => {
    const surface = mount({ width: 300 })
    expect([surface.style.width, surface.style.minWidth]).toEqual(['300px', ''])
  })

  it('minWidth is a floor, no fixed width', () => {
    const surface = mount({ minWidth: 260 })
    expect([surface.style.width, surface.style.minWidth]).toEqual(['', '260px'])
  })
})
