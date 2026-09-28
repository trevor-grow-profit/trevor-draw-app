import { isRecord } from '@shared/guards'
import { BridgeFailure, requireAbsPath } from './fsUtils'

/**
 * THE SHAPE CHECKS OF A REQUEST (YAZ-2073 6D). A sandboxed renderer's arguments arrive as `unknown`;
 * each check refuses `BAD_REQUEST` in the wording the doors have always used, since a renderer may
 * show it. What a value MEANS (a real slug, a scene, a vault path) stays with the module that owns it.
 */
const refuse = (message: string): never => {
  throw new BridgeFailure('BAD_REQUEST', message)
}

/** A request, patch or options object — never an array. `message` is the door's own wording. */
export const requireObject = (v: unknown, message = 'request must be an object'): Record<string, unknown> => (isRecord(v) ? v : refuse(message))

export const str = (v: unknown, name: string): string => (typeof v === 'string' && v !== '' ? v : refuse(`'${name}' must be a non-empty string`))

/** Absent, or any string. */
export const optStr = (v: unknown, name: string): string | undefined => (v === undefined || typeof v === 'string' ? v : refuse(`'${name}' must be a string`))

/** A string or null; a door that also allows absence checks for it first. */
export const strOrNull = (v: unknown, name: string): string | null => (v === null || typeof v === 'string' ? v : refuse(`'${name}' must be a string or null`))

export const bool = (v: unknown, name: string): boolean => (typeof v === 'boolean' ? v : refuse(`'${name}' must be a boolean`))

export const optBool = (v: unknown, name: string): boolean | undefined => (v === undefined ? v : bool(v, name))

/** Absolute paths only — one bad element refuses the whole call, named `name[i]`. */
export const absPaths = (v: unknown, name: string): string[] =>
  Array.isArray(v) ? v.map((p, i) => requireAbsPath(p, `${name}[${i}]`)) : refuse(`'${name}' must be an array of absolute paths`)
