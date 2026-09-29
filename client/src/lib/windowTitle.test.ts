import { describe, expect, it } from 'vitest'
import { APP_NAME, windowTitle } from './windowTitle'

describe('windowTitle', () => {
  it('composes "<file> — <vault>" Obsidian-style from the vault NAME (Docs YAZ-1974 D4), vault extension stripped', () => {
    expect(windowTitle('notes', '/vaults/notes/Ideas.excalidraw')).toBe('Ideas — notes')
    expect(windowTitle('Business Wiki', '/vaults/business-wiki-MASTER/sub/Plan.excalidraw')).toBe('Plan — Business Wiki')
  })

  it('is the vault name alone when no file is open', () => {
    expect(windowTitle('Draw Vault', null)).toBe('Draw Vault')
  })

  it('is the app name on the Welcome screen (no vault), whatever the file says', () => {
    expect(APP_NAME).toBe('Trevor Draw')
    expect(windowTitle(null, null)).toBe(APP_NAME)
    expect(windowTitle(null, '/stray.md')).toBe(APP_NAME)
  })
})
