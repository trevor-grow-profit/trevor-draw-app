import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileLink, parseFileLink } from './links'

// YAZ-2073 2D: a Windows double-click reaches main as `C:\…\Board.excalidraw` (argv) and rides the
// same fileLink → parseFileLink pipeline as a macOS `open-file` path. Both must round-trip.

describe('fileLink / parseFileLink', () => {
  it.each([
    [posix.join('/Users', 'me', 'Vault', 'Board.excalidraw'), 'yaseendraw:///Users/me/Vault/Board.excalidraw'],
    ['/v/My note #1?.excalidraw', 'yaseendraw:///v/My%20note%20%231%3F.excalidraw'],
    ['/v/ünïcode näme.drawio', 'yaseendraw:///v/%C3%BCn%C3%AFcode%20n%C3%A4me.drawio'],
    [win32.join('C:\\', 'Users', 'me', 'Vault', 'Board.excalidraw'), 'yaseendraw:///C:/Users/me/Vault/Board.excalidraw'],
    [win32.join('d:\\', 'My Vault', '#1?.drawio'), 'yaseendraw:///d:/My%20Vault/%231%3F.drawio'],
  ])('%s ⇄ %s', (path, link) => {
    expect(fileLink(path)).toBe(link)
    expect(parseFileLink(link)).toEqual({ path, root: null })
  })

  it('a Windows path written with forward slashes still opens, in its native form', () => {
    expect(parseFileLink(fileLink('C:/Vault/a.excalidraw'))).toEqual({ path: 'C:\\Vault\\a.excalidraw', root: null })
  })

  it('a ?root= override round-trips on both platforms', () => {
    const win = win32.join('C:\\', 'Vault', 'sub', 'a.excalidraw')
    expect(parseFileLink(`${fileLink(win)}?root=${encodeURIComponent('/C:/Vault')}`)).toEqual({ path: win, root: 'C:\\Vault' })
    expect(parseFileLink(`${fileLink('/v/sub/a.excalidraw')}?root=${encodeURIComponent('/v')}`)).toEqual({ path: '/v/sub/a.excalidraw', root: '/v' })
  })

  it.each([
    'https://example.com/a.excalidraw',
    'yaseendraw://Users/me/a.excalidraw', // relative once decoded
    'yaseendraw://C:%5CUsers%5Ca.excalidraw', // a raw drive path is not the link form
    'yaseendraw:///v/%E0%A4%A.excalidraw', // malformed escape
  ])('refuses %s', (url) => expect(parseFileLink(url)).toBeNull())

  it('a relative ?root= is no override at all', () => {
    expect(parseFileLink('yaseendraw:///v/a.excalidraw?root=v')).toEqual({ path: '/v/a.excalidraw', root: null })
  })
})
