/**
 * The focus-handoff gate (🔒 YAZ-1812, built in YAZ-1815): a drawing tab that becomes visible takes the
 * keyboard so tool hotkeys work without a click — but only when nothing else is holding it.
 */
import { describe, expect, it } from 'vitest'
import { mayTakeFocus } from './focusHandoff'

const layer = document.createElement('div')
const canvas = document.createElement('div')
layer.appendChild(canvas)
const elsewhere = document.createElement('input')

describe('mayTakeFocus', () => {
  it('takes it when NOTHING holds the keyboard', () => {
    expect(mayTakeFocus(null, layer)).toBe(true)
    expect(mayTakeFocus(document.body, layer)).toBe(true)
  })

  it('takes it from inside the tab layer — the tab being left hands over to the one arriving', () => {
    expect(mayTakeFocus(canvas, layer)).toBe(true)
    expect(mayTakeFocus(layer, layer)).toBe(true)
  })

  it('NEVER takes it from chrome outside the layer — ⌘K, the vault switcher, a dialog keep it', () => {
    expect(mayTakeFocus(elsewhere, layer)).toBe(false)
  })

  it('with no layer to compare against, only the nobody-holds-it case passes', () => {
    expect(mayTakeFocus(null, null)).toBe(true)
    expect(mayTakeFocus(elsewhere, null)).toBe(false)
  })
})
