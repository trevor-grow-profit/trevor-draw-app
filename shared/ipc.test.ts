import { describe, expect, it } from 'vitest'
import { CONTRACT, leaves, SPECIAL } from './ipc'

describe('CONTRACT (YAZ-2073 🔒 D16)', () => {
  it('names every channel once: no two doors, and no special, share one', () => {
    const all = [...leaves(CONTRACT).map(([, v]) => v.channel), ...Object.values(SPECIAL)]
    expect(new Set(all).size).toBe(all.length)
  })

  it('a push is an `on…` subscription and an invoke never is', () => {
    for (const [name, v] of leaves(CONTRACT)) expect(/(^|\.)on[A-Z]/.test(name), name).toBe(v.kind === 'push')
  })
})
