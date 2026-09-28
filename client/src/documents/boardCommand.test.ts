import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeBoardSection, BOARD_COMMAND_EVENT, requestBoardCommand, type BoardCommand } from './boardCommand'

/** Two mounted tabs, as the workspace renders them: one visible layer, one hidden. */
function stack(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.append(host)
  return host
}

afterEach(() => {
  document.body.innerHTML = ''
})

const VISIBLE = '<div class="tabstack__layer"><section class="editor editor--drawing" data-which="visible"></section></div>'
const HIDDEN = '<div class="tabstack__layer tabstack__layer--hidden"><section class="editor editor--drawing" data-which="hidden"></section></div>'

describe('activeBoardSection', () => {
  it('finds the VISIBLE layer`s drawing and never a hidden one', () => {
    const host = stack(HIDDEN + VISIBLE)
    expect(activeBoardSection(host)?.getAttribute('data-which')).toBe('visible')
  })

  it('is null when every mounted drawing is hidden', () => {
    expect(activeBoardSection(stack(HIDDEN))).toBeNull()
  })

  it('finds a visible draw.io diagram too — Export Image… works on either kind (🔒 YAZ-1802 D9)', () => {
    const host = stack(HIDDEN + '<div class="tabstack__layer"><section class="editor editor--diagram" data-which="diagram"></section></div>')
    expect(activeBoardSection(host)?.getAttribute('data-which')).toBe('diagram')
  })

  it('is null when the visible tab is not a board', () => {
    expect(activeBoardSection(stack('<div class="tabstack__layer"><section class="editor"></section></div>' + HIDDEN))).toBeNull()
  })
})

describe('requestBoardCommand', () => {
  it('dispatches to the visible drawing ONLY — the hidden tab`s engine never hears it', () => {
    const host = stack(HIDDEN + VISIBLE)
    const seen: Array<[string, BoardCommand]> = []
    for (const section of host.querySelectorAll('.editor--drawing')) {
      section.addEventListener(BOARD_COMMAND_EVENT, (e) => seen.push([section.getAttribute('data-which') ?? '', (e as CustomEvent<BoardCommand>).detail]))
    }
    expect(requestBoardCommand({ kind: 'export-image' }, host)).toBe(true)
    expect(requestBoardCommand({ kind: 'canvas-background', color: '#fffce8' }, host)).toBe(true)
    expect(seen).toEqual([
      ['visible', { kind: 'export-image' }],
      ['visible', { kind: 'canvas-background', color: '#fffce8' }],
    ])
  })

  it('does not bubble — a listener on an ancestor is not a second claimant', () => {
    const host = stack(VISIBLE)
    const onHost = vi.fn()
    host.addEventListener(BOARD_COMMAND_EVENT, onHost)
    requestBoardCommand({ kind: 'export-image' }, host)
    expect(onHost).not.toHaveBeenCalled()
  })

  it('answers false when nothing is there to take it', () => {
    expect(requestBoardCommand({ kind: 'export-image' }, stack(HIDDEN))).toBe(false)
  })
})
