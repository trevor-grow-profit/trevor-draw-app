import { describe, expect, it } from 'vitest'
import { CONTRACT, isLeaf, SPECIAL } from './ipc'

/** Every leaf of the table, with its dotted name. */
const leaves = (table: object, at = ''): [string, { kind: string; channel: string }][] =>
  Object.entries(table).flatMap(([key, v]) => (isLeaf(v) ? [[`${at}${key}`, v] as [string, typeof v]] : leaves(v, `${at}${key}.`)))

describe('CONTRACT (YAZ-2073 🔒 D16)', () => {
  it('names every channel once: no two doors, and no special, share one', () => {
    const all = [...leaves(CONTRACT).map(([, v]) => v.channel), ...Object.values(SPECIAL)]
    expect(new Set(all).size).toBe(all.length)
  })

  it('a push is an `on…` subscription and an invoke never is', () => {
    for (const [name, v] of leaves(CONTRACT)) expect(/(^|\.)on[A-Z]/.test(name), name).toBe(v.kind === 'push')
  })
})
