import { contextBridge, ipcRenderer } from 'electron'
import type { WatchEvent } from '@shared/types'
import { CONTRACT, type Envelope, isLeaf, SPECIAL, type YaseenDrawApi } from '@shared/ipc'

/** invoke + unwrap: resolves the value or rejects with the plain `BridgeError` object. */
const invoker =
  (channel: string) =>
  async (...args: unknown[]): Promise<unknown> => {
    const env = (await ipcRenderer.invoke(channel, ...args)) as Envelope<unknown>
    if (env.ok) return env.value
    throw env.error
  }

/** One push channel as a subscribe function: `on(listener)` returns the unsubscribe. */
const subscriber = (channel: string) => (listener: (payload: unknown) => void) => {
  const handler = (_e: unknown, payload: unknown) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => void ipcRenderer.removeListener(channel, handler)
}

/** The table's shape with each leaf turned into its function (YAZ-2073 🔒 D16): only its channels exist. */
export function buildBridge(table: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(table).map(([key, v]) => [key, isLeaf(v) ? (v.kind === 'invoke' ? invoker(v.channel) : subscriber(v.channel)) : buildBridge(v as object)]))
}

/**
 * The close/quit flush handshake (GRO-2160): main sends `app:flush` and holds the window until
 * `app:flushed` comes back. Every registered listener is awaited (none registered — e.g. the
 * Welcome window — acks at once); a rejection still acks, main's 5s cap is the only other out.
 */
const flushListeners = new Set<() => Promise<void> | void>()
ipcRenderer.on(SPECIAL.appFlush, () => {
  void Promise.allSettled([...flushListeners].map(async (listener) => listener())).then(() => ipcRenderer.send(SPECIAL.appFlushed))
})

const generated = buildBridge(CONTRACT)
const api = {
  ...generated,
  watch: (root: string, listener: (ev: WatchEvent) => void) => {
    const id = crypto.randomUUID()
    const onEvent = (_e: unknown, msg: { id: string; ev: WatchEvent }) => {
      if (msg.id === id) listener(msg.ev)
    }
    ipcRenderer.on(SPECIAL.watchEvent, onEvent)
    ipcRenderer.send(SPECIAL.watchSubscribe, { id, root })
    return () => {
      ipcRenderer.removeListener(SPECIAL.watchEvent, onEvent)
      ipcRenderer.send(SPECIAL.watchUnsubscribe, id)
    }
  },
  window: {
    ...(generated.window as object),
    onFlush: (listener: () => Promise<void> | void) => {
      flushListeners.add(listener)
      return () => void flushListeners.delete(listener)
    },
  },
} as YaseenDrawApi

contextBridge.exposeInMainWorld('yaseenDraw', api)

/** Exported for the preload's own test (the preload is otherwise side-effect driven). */
export { api as bridge }
