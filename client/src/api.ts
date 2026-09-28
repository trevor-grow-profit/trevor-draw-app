import type { BridgeError, BridgeErrorCode } from '@shared/types'
import { type Bridge, CONTRACT, isLeaf } from '@shared/ipc'

/** Typed failure from the main process (see docs/CONTRACTS.md "Bridge API"). */
export class BridgeRequestError extends Error {
  constructor(
    readonly code: BridgeErrorCode | 'CONFLICT',
    message: string,
    /** Current on-disk mtime, only present on CONFLICT. */
    readonly mtime?: number,
    /** The offending path, when the main process attributed the failure to one. */
    readonly path?: string,
  ) {
    super(message)
    this.name = 'BridgeRequestError'
  }
}

function isBridgeError(err: unknown): err is BridgeError {
  return typeof err === 'object' && err !== null && typeof (err as BridgeError).code === 'string' && typeof (err as BridgeError).message === 'string'
}

/** The bridge rejects with a plain `BridgeError` object (no prototype survives IPC); give it a class. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (isBridgeError(err)) throw new BridgeRequestError(err.code, err.message, err.mtime, err.path)
    throw new BridgeRequestError('IO_ERROR', err instanceof Error ? err.message : String(err))
  }
}

type Fns = Record<string, (...args: unknown[]) => unknown>

/**
 * `window.yaseenDraw` in `CONTRACT`'s shape (YAZ-2073 🔒 D16), looked up at call time: an invoke
 * rejects with a `BridgeRequestError`, a push subscribes as it is.
 */
function wrap(table: object, at: string[]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(table).map(([key, v]) => {
      if (!isLeaf(v)) return [key, wrap(v, [...at, key])]
      const host = () => at.reduce<Fns>((o, k) => o[k] as unknown as Fns, window.yaseenDraw as unknown as Fns)
      return [key, v.kind === 'invoke' ? (...args: unknown[]) => call(async () => host()[key](...args)) : (listener: unknown) => host()[key](listener)]
    }),
  )
}

const bridge = wrap(CONTRACT, []) as Bridge<typeof CONTRACT>

/** The renderer's one door to main: every call to `window.yaseenDraw` goes through here. */
export const api = {
  ...bridge,
  watch: (...args: Parameters<Window['yaseenDraw']['watch']>) => window.yaseenDraw.watch(...args),
  window: { ...bridge.window, onFlush: (listener: () => Promise<void> | void) => window.yaseenDraw.window.onFlush(listener) },
}
