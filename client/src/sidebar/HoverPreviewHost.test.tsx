/** The hover preview's dwell, driven directly on the Sidebar's half (YAZ-1800; a hook since YAZ-2073 6C). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { FileNode } from '@shared/treeSort'
import { BOARD_PREVIEW_DWELL_MS, useHoverPreview } from './HoverPreviewHost'

const board = (name: string): FileNode => ({ type: 'file', name: `${name}.excalidraw`, path: `/v/${name}.excalidraw`, size: 1, mtime: 1, kind: 'drawing' })

let root: Root | null = null
let hook: ReturnType<typeof useHoverPreview>
interface ProbeProps {
  blocked: boolean
  enabled: boolean
  activeFile: string | null
}
function Probe({ blocked, enabled, activeFile }: ProbeProps) {
  hook = useHoverPreview(blocked, enabled, activeFile)
  return null
}
const render = (props: Partial<ProbeProps> = {}) => act(() => root?.render(<Probe blocked={false} enabled activeFile={null} {...props} />))
const state = () => hook.hover.getState()
const wait = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

beforeEach(() => {
  vi.useFakeTimers()
  root = createRoot(document.createElement('div'))
})
afterEach(() => {
  act(() => root?.unmount())
  vi.useRealTimers()
})

describe('useHoverPreview', () => {
  it('the same row again (focus after the pointer, or back) keeps its dwell rather than restarting it', () => {
    render()
    act(() => hook.hoverFile(board('a')))
    expect(state()).toEqual({ path: '/v/a.excalidraw', shown: false })
    wait(BOARD_PREVIEW_DWELL_MS - 1)
    act(() => hook.hoverFile(board('a')))
    wait(1)
    expect(state()).toEqual({ path: '/v/a.excalidraw', shown: true })
  })

  it('an earlier row`s dwell never fires for the next one', () => {
    render()
    act(() => hook.hoverFile(board('a')))
    wait(BOARD_PREVIEW_DWELL_MS - 100)
    act(() => hook.hoverFile(board('b')))
    wait(100)
    expect(state()).toEqual({ path: '/v/b.excalidraw', shown: false })
    wait(BOARD_PREVIEW_DWELL_MS)
    expect(state()).toEqual({ path: '/v/b.excalidraw', shown: true })
  })

  it('opens nothing while blocked, and closes on blocking, disabling, or another board opening', () => {
    render({ blocked: true })
    act(() => hook.hoverFile(board('a')))
    wait(BOARD_PREVIEW_DWELL_MS)
    expect(state().path).toBeNull()
    for (const next of [{ blocked: true }, { enabled: false }, { activeFile: '/v/b.excalidraw' }]) {
      render()
      act(() => hook.hoverFile(board('a')))
      wait(BOARD_PREVIEW_DWELL_MS)
      expect(state().shown).toBe(true)
      render(next)
      expect(state()).toEqual({ path: null, shown: false })
    }
  })
})
