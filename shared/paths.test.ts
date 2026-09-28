import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isWithin, sepOf } from './paths'

// YAZ-2073 2D: one containment rule for POSIX and Windows paths. The Windows rows are built with
// `path.win32`, exactly as main builds them on a Windows machine.

const P = posix.join('/', 'Users', 'me', 'Vault')
const W = win32.join('C:\\', 'Users', 'me', 'Vault')

describe('sepOf', () => {
  it.each([
    [P, '/'],
    ['/', '/'],
    [W, '\\'],
    ['C:\\', '\\'],
    ['\\\\server\\share', '\\'],
    ['C:/Users/me', '/'],
    ['/odd\\name', '/'],
  ])('%s → %s', (p, sep) => expect(sepOf(p)).toBe(sep))
})

describe('isWithin', () => {
  it.each([
    // [base, p, within, strictly within]
    [P, P, true, false],
    [P, posix.join(P, 'a.excalidraw'), true, true],
    [P, posix.join(P, 'sub', 'deep', 'a.excalidraw'), true, true],
    [P, `${P}2/a.excalidraw`, false, false], // a sibling that shares the prefix
    [P, posix.dirname(P), false, false],
    [`${P}/`, posix.join(P, 'a.excalidraw'), true, true],
    [`${P}/`, P, true, false],
    ['/', '/a.excalidraw', true, true],
    ['/', '/', true, false],
    [W, W, true, false],
    [W, win32.join(W, 'a.excalidraw'), true, true],
    [W, win32.join(W, 'sub', 'deep', 'a.excalidraw'), true, true],
    [W, `${W}2\\a.excalidraw`, false, false],
    [W, win32.dirname(W), false, false],
    [`${W}\\`, win32.join(W, 'a.excalidraw'), true, true],
    ['C:\\', 'C:\\a.excalidraw', true, true],
    ['C:\\', 'D:\\a.excalidraw', false, false],
    [W, posix.join(P, 'a.excalidraw'), false, false],
    [P, `${P}\\a.excalidraw`, false, false], // on POSIX a `\` is part of a name, not a separator
  ])('%s ⊇ %s: %s (strict %s)', (base, p, within, strictly) => {
    expect(isWithin(base, p)).toBe(within)
    expect(isWithin(base, p, true)).toBe(strictly)
  })
})
