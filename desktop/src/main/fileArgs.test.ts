/**
 * Argv is the ONLY place Windows and Linux put a double-clicked `.excalidraw` (YAZ-1815):
 * there is no `open-file` event off macOS, so a cold launch and a `second-instance` both read it.
 */
import { describe, expect, it } from 'vitest'
import { openableFileArgs } from './fileArgs'

describe('openableFileArgs', () => {
  it('takes a drawing handed over by a double-click on a packaged app', () => {
    expect(openableFileArgs(['C:\\Program Files\\Trevor Draw\\Trevor Draw.exe', 'C:\\vault\\Board.excalidraw'])).toEqual(['C:\\vault\\Board.excalidraw'])
  })

  it('takes several, in order', () => {
    expect(openableFileArgs(['app.exe', '/v/A.excalidraw', '/v/B.excalidraw'])).toEqual(['/v/A.excalidraw', '/v/B.excalidraw'])
  })

  it('never takes the executable itself, nor the app directory a dev launch passes', () => {
    expect(openableFileArgs(['electron', '.', '/v/Board.excalidraw'], 2)).toEqual(['/v/Board.excalidraw'])
    expect(openableFileArgs(['/path/to/Board.excalidraw'])).toEqual([])
  })

  it('never takes a switch, even one that ends in the extension', () => {
    expect(openableFileArgs(['app.exe', '--inspect', '--trace=x.excalidraw', '-psn_0_123'])).toEqual([])
  })

  it('never takes a deep link — the caller routes `yaseendraw://` itself', () => {
    expect(openableFileArgs(['app.exe', 'yaseendraw:///v/Board.excalidraw'])).toEqual([])
  })

  it('never takes a file of a kind this app does not own', () => {
    expect(openableFileArgs(['app.exe', '/v/notes.md', '/v/photo.png', '/v/no-extension'])).toEqual([])
  })

  it('is case-insensitive about the extension, as the OS is', () => {
    expect(openableFileArgs(['app.exe', '/v/Board.EXCALIDRAW'])).toEqual(['/v/Board.EXCALIDRAW'])
  })

  it('🔒 YAZ-1802 D14: takes a draw.io diagram in any case, never a picture that holds one', () => {
    expect(openableFileArgs(['app.exe', '/v/Flow.drawio', '/v/UP.DRAWIO', '/v/image.drawio.svg', '/v/image.drawio.png'])).toEqual(['/v/Flow.drawio', '/v/UP.DRAWIO'])
  })

  it('an empty argv, or one with nothing but the launcher, asks for nothing', () => {
    expect(openableFileArgs([])).toEqual([])
    expect(openableFileArgs(['app.exe'])).toEqual([])
    expect(openableFileArgs(['app.exe', ''])).toEqual([])
  })
})
