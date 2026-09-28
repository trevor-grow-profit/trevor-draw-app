import { describe, expect, it } from 'vitest'
import { summarize, summarizeRuns } from './lib/stats.mjs'

describe('summarize', () => {
  it('reports the median, nearest-rank p95, range and noise', () => {
    expect(summarize([500, 580, 560, 620, 590])).toEqual({ median: 580, p95: 620, min: 500, max: 620, cv: 0.07, runs: [500, 580, 560, 620, 590] })
  })

  it('is null when nothing was measured', () => {
    expect(summarize([undefined, null])).toBeNull()
  })

  it('has no noise for identical runs', () => {
    expect(summarize([8.3, 8.3]).cv).toBe(0)
  })
})

describe('summarizeRuns', () => {
  it('summarizes every metric any run reported', () => {
    const out = summarizeRuns([{ a: 1, b: 10 }, { a: 3 }])
    expect(out.a.median).toBe(1)
    expect(out.b.runs).toEqual([10])
  })
})
