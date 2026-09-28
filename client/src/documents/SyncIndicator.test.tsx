/**
 * The GitHub sync chip (YAZ-1081 3A, 🔒 YAZ-1775 D5): SaveIndicator's dot-plus-label idiom, one state
 * class per state, and a real `<button>` — the chip IS the one-click sync, so every state
 * clicks, `off` included (the engine answers `off` and nothing happens).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { GithubSyncStatus } from '@shared/types'
import { SyncIndicator } from './SyncIndicator'


let root: Root | null = null
let container: HTMLElement | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
})

function mount(status: Partial<GithubSyncStatus> & Pick<GithubSyncStatus, 'state'>) {
  const onSyncNow = vi.fn()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root?.render(<SyncIndicator status={{ root: '/vault', ...status }} onSyncNow={onSyncNow} />))
  return { chip: container.querySelector<HTMLButtonElement>('.sync-indicator')!, onSyncNow }
}

const STATES: Array<[GithubSyncStatus['state'], string]> = [
  ['synced', 'Synced'],
  ['pending', 'Pending'],
  ['syncing', 'Syncing…'],
  ['attention', 'Attention'],
  ['off', 'Sync off'],
]

describe('SyncIndicator (YAZ-1081 3A)', () => {
  it.each(STATES)('%s renders "%s" with its own state class and a dot', (state, label) => {
    const { chip } = mount({ state })
    expect(chip.textContent).toBe(label)
    expect(chip.classList.contains(`sync-indicator--${state}`)).toBe(true)
    expect(chip.querySelector('.sync-indicator__dot')).not.toBeNull()
  })

  it('is a button — the chip IS the sync action, not a label beside one', () => {
    const { chip } = mount({ state: 'synced' })
    expect(chip.tagName).toBe('BUTTON')
    expect(chip.type).toBe('button')
    expect(chip.getAttribute('aria-live')).toBe('polite')
  })

  it.each(STATES)('%s carries a title explaining itself', (state) => {
    const { chip } = mount({ state })
    expect(chip.title.length).toBeGreaterThan(0)
  })

  it('the synced title offers the click', () => {
    expect(mount({ state: 'synced' }).chip.title).toBe('Synced with GitHub — click to sync now')
  })

  it('the off title says why nothing is happening, without calling it a failure', () => {
    expect(mount({ state: 'off' }).chip.title).toBe('GitHub sync is off for this vault')
  })

  it("attention folds the engine's own message into the title when it carries one", () => {
    const { chip } = mount({ state: 'attention', attention: 'auth', message: 'authentication failed' })
    expect(chip.title).toContain('authentication failed')
  })

  it('a message-less attention still explains itself and offers the retry', () => {
    const { chip } = mount({ state: 'attention', attention: 'conflict' })
    expect(chip.title).toBe('GitHub sync needs attention — click to try again')
  })

  it('clicking fires onSyncNow', () => {
    const { chip, onSyncNow } = mount({ state: 'pending' })
    chip.click()
    expect(onSyncNow).toHaveBeenCalledOnce()
  })

  it('clicking while off fires it too — the engine, not the chip, decides that means nothing', () => {
    const { chip, onSyncNow } = mount({ state: 'off' })
    chip.click()
    expect(onSyncNow).toHaveBeenCalledOnce()
  })
})

describe('SyncIndicator — files over GitHub\'s limit (YAZ-1801 D3)', () => {
  it('outranks the state label: red, counted, and the hover names every held-back file', () => {
    const { chip } = mount({ state: 'attention', attention: 'too-large', tooLarge: ['Too big.excalidraw', 'Big video.mov'] })
    expect(chip.textContent).toBe('2 files not synced')
    expect(chip.classList.contains('sync-indicator--attention')).toBe(true)
    expect(chip.title).toContain('Too big.excalidraw, Big video.mov')
  })

  it('stays up while a pass is running (the list rides a syncing status)', () => {
    const { chip } = mount({ state: 'syncing', tooLarge: ['Too big.excalidraw'] })
    expect(chip.textContent).toBe('1 file not synced')
  })
})
