import { describe, expect, it } from 'vitest'
import { runQuitSequence, type QuitDeps } from './quitSequence'

// YAZ-2073 D11: renderers → (state file ∥ last sync pass) → exit. Each step is a deferred the test
// resolves by hand, so a missing, reordered or un-awaited step fails here, not on a user's ⌘Q.

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((a, b) => ((resolve = a), (reject = b)))
  return { promise, resolve, reject }
}

function harness(withSync = true) {
  const log: string[] = []
  const steps = { renderers: deferred(), store: deferred(), sync: deferred() }
  const deps: QuitDeps = {
    manager: { flushAllForQuit: () => (log.push('renderers'), steps.renderers.promise) },
    store: { flush: () => (log.push('store'), steps.store.promise) },
    gitSync: withSync ? { flushForQuit: () => (log.push('sync'), steps.sync.promise) } : undefined,
    exit: () => void log.push('exit'),
  }
  return { log, steps, deps }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('runQuitSequence', () => {
  it('flushes the renderers first, then the state file and sync together, then exits', async () => {
    const { log, steps, deps } = harness()
    const done = runQuitSequence(deps)
    await tick()
    expect(log).toEqual(['renderers'])
    steps.renderers.resolve()
    await tick()
    expect(log).toEqual(['renderers', 'store', 'sync'])
    steps.store.resolve()
    await tick()
    expect(log).not.toContain('exit') // the last sync commit + push is still running
    steps.sync.resolve()
    await done
    expect(log).toEqual(['renderers', 'store', 'sync', 'exit'])
  })

  it('still exits, after both settle, when the state write or the sync pass fails', async () => {
    const { log, steps, deps } = harness()
    const done = runQuitSequence(deps)
    steps.renderers.resolve()
    await tick()
    steps.store.reject(new Error('disk full'))
    await tick()
    expect(log).not.toContain('exit')
    steps.sync.reject(new Error('offline'))
    await done
    expect(log).toEqual(['renderers', 'store', 'sync', 'exit'])
  })

  it('flushes the state file and exits when sync never started (quit before ready)', async () => {
    const { log, steps, deps } = harness(false)
    const done = runQuitSequence(deps)
    steps.renderers.resolve()
    await tick()
    steps.store.resolve()
    await done
    expect(log).toEqual(['renderers', 'store', 'exit'])
  })

  it('a renderer flush that rejects still writes the state file and runs the last sync, then exits, and never rejects', async () => {
    const { log, steps, deps } = harness()
    const done = runQuitSequence(deps)
    steps.renderers.reject(new Error('boom'))
    await tick()
    expect(log).toEqual(['renderers', 'store', 'sync'])
    steps.store.resolve()
    steps.sync.resolve()
    await expect(done).resolves.toBeUndefined()
    expect(log).toEqual(['renderers', 'store', 'sync', 'exit'])
  })
})
