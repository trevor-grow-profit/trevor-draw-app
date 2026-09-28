import { describe, expect, it } from 'vitest'
import { BridgeFailure } from './fsUtils'
import { absPaths, bool, optBool, optStr, requireObject, str, strOrNull } from './validate'

/** The refusal `fn` throws, as the renderer's envelope would carry it. */
function refusal(fn: () => unknown): { code: string; message: string } {
  try {
    fn()
  } catch (err) {
    if (err instanceof BridgeFailure) return { code: err.code, message: err.message }
    throw err
  }
  throw new Error('expected a refusal')
}

// YAZ-2073 6D: the wording is the doors' own, byte for byte — a renderer may show it.
describe('request shape checks', () => {
  it('requireObject takes a plain object and refuses anything else with the door’s wording', () => {
    const body = { a: 1 }
    expect(requireObject(body)).toBe(body)
    for (const bad of [null, undefined, 'x', 3, []]) expect(refusal(() => requireObject(bad))).toEqual({ code: 'BAD_REQUEST', message: 'request must be an object' })
    expect(refusal(() => requireObject(null, 'missing request'))).toEqual({ code: 'BAD_REQUEST', message: 'missing request' })
    expect(refusal(() => requireObject([], 'patch must be an object'))).toEqual({ code: 'BAD_REQUEST', message: 'patch must be an object' })
  })

  it('str takes a non-empty string', () => {
    expect(str('a', 'token')).toBe('a')
    for (const bad of ['', undefined, null, 1]) expect(refusal(() => str(bad, 'token'))).toEqual({ code: 'BAD_REQUEST', message: "'token' must be a non-empty string" })
  })

  it('optStr takes absence or any string', () => {
    expect(optStr(undefined, 'id')).toBeUndefined()
    expect(optStr('', 'id')).toBe('')
    for (const bad of [null, 1, false]) expect(refusal(() => optStr(bad, 'id'))).toEqual({ code: 'BAD_REQUEST', message: "'id' must be a string" })
  })

  it('strOrNull takes a string or null, and refuses absence', () => {
    expect(strOrNull(null, 'root')).toBeNull()
    expect(strOrNull('', 'root')).toBe('')
    for (const bad of [undefined, 1, {}]) expect(refusal(() => strOrNull(bad, 'root'))).toEqual({ code: 'BAD_REQUEST', message: "'root' must be a string or null" })
  })

  it('bool takes a boolean; optBool also takes absence', () => {
    expect(bool(false, 'enabled')).toBe(false)
    expect(optBool(undefined, 'check')).toBeUndefined()
    expect(optBool(true, 'check')).toBe(true)
    for (const bad of [undefined, 'true', 0]) expect(refusal(() => bool(bad, 'enabled'))).toEqual({ code: 'BAD_REQUEST', message: "'enabled' must be a boolean" })
    for (const bad of [null, 'true', 0]) expect(refusal(() => optBool(bad, 'check'))).toEqual({ code: 'BAD_REQUEST', message: "'check' must be a boolean" })
  })

  it('absPaths takes an array of absolute paths, naming the element that is not one', () => {
    expect(absPaths(['/a', '/b/../c'], 'skip')).toEqual(['/a', '/c'])
    expect(refusal(() => absPaths('/a', 'tabs'))).toEqual({ code: 'BAD_REQUEST', message: "'tabs' must be an array of absolute paths" })
    expect(refusal(() => absPaths(['/a', 'rel'], 'focusDirs'))).toEqual({ code: 'NOT_ABSOLUTE', message: "'focusDirs[1]' must be an absolute path" })
    expect(refusal(() => absPaths(['/a', ''], 'skip'))).toEqual({ code: 'BAD_REQUEST', message: "missing 'skip[1]'" })
  })
})
