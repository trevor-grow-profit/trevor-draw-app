import path from 'node:path'
import { isRecord, isStringArray } from '@shared/guards'
import { BridgeFailure } from './fsUtils'

/**
 * THE SHAPE CHECKS OF A REQUEST (YAZ-2073 6D). A sandboxed renderer's arguments arrive as `unknown`;
 * each check refuses `BAD_REQUEST` (a path that is not absolute: `NOT_ABSOLUTE`) in the wording the
 * doors have always used, since a renderer may show it. What a value MEANS (a real slug, a scene, a
 * vault path) stays with the module that owns it. It lives under `fs/` beside `BridgeFailure`, though
 * the `ipc/` doors are most of its callers.
 */
const refuse = (message: string): never => {
  throw new BridgeFailure('BAD_REQUEST', message)
}

/** A request, patch or options object — never an array. `message` is the door's own wording. */
export const requireObject = (v: unknown, message = 'request must be an object'): Record<string, unknown> => (isRecord(v) ? v : refuse(message))

/** A door's one request object, refused in the wording every door shares. */
export const requireRequest = (v: unknown): Record<string, unknown> => requireObject(v, 'missing request')

export const str = (v: unknown, name: string): string => (typeof v === 'string' && v !== '' ? v : refuse(`'${name}' must be a non-empty string`))

/** Absent, or any string. */
export const optStr = (v: unknown, name: string): string | undefined => (v === undefined || typeof v === 'string' ? v : refuse(`'${name}' must be a string`))

/** A string or null; a door that also allows absence checks for it first. */
export const strOrNull = (v: unknown, name: string): string | null => (v === null || typeof v === 'string' ? v : refuse(`'${name}' must be a string or null`))

/** An array of strings, any strings. */
export const strArray = (v: unknown, name: string): string[] => (isStringArray(v) ? v : refuse(`'${name}' must be a string array`))

export const bool = (v: unknown, name: string): boolean => (typeof v === 'boolean' ? v : refuse(`'${name}' must be a boolean`))

export const optBool = (v: unknown, name: string): boolean | undefined => (v === undefined ? v : bool(v, name))

const isSafeAbsPath = (p: unknown): p is string => typeof p === 'string' && path.isAbsolute(p) && !p.includes('\0')

/** Validates + normalises a path argument, throwing BAD_REQUEST / NOT_ABSOLUTE when missing/relative. */
export function requireAbsPath(p: unknown, param: string): string {
  if (p === undefined || p === '') refuse(`missing '${param}'`)
  if (!isSafeAbsPath(p)) throw new BridgeFailure('NOT_ABSOLUTE', `'${param}' must be an absolute path`, { path: String(p) })
  return path.resolve(p)
}

/** Absolute paths only — one bad element refuses the whole call, named `name[i]`. */
export const absPaths = (v: unknown, name: string): string[] =>
  Array.isArray(v) ? v.map((p, i) => requireAbsPath(p, `${name}[${i}]`)) : refuse(`'${name}' must be an array of absolute paths`)
