/** Numbers for the perf runner (YAZ-2073 1B): per-metric summaries, and the in-page frame sampler. */

/** Nearest-rank percentile of an ascending list. */
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
const round = (n) => Math.round(n * 10) / 10

/** One metric over the measured runs: median and p95 are the reported numbers; `cv` (stdev / mean) is the noise. */
export function summarize(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x))
  if (v.length === 0) return null
  const sorted = [...v].sort((a, b) => a - b)
  const mean = v.reduce((a, b) => a + b, 0) / v.length
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length)
  return { median: round(pct(sorted, 0.5)), p95: round(pct(sorted, 0.95)), min: round(sorted[0]), max: round(sorted.at(-1)), cv: mean === 0 ? 0 : Math.round((sd / mean) * 100) / 100, runs: v.map(round) }
}

/** Every metric of every run, summarized by name. */
export function summarizeRuns(runs) {
  const names = [...new Set(runs.flatMap((r) => Object.keys(r)))]
  return Object.fromEntries(names.map((k) => [k, summarize(runs.map((r) => r[k]))]))
}

/**
 * Evaluated in the page: `__perf.start()` … `__perf.stop()` samples every animation frame's delta
 * and every long task. A frame over 20 ms is a visible hitch at 120 Hz; the scope's targets
 * (no frame over 20 ms, no long task over 50 ms) read straight off `max` and `longTaskMax`.
 */
export const FRAME_SAMPLER = `window.__perf ??= {
  start() {
    const s = (this.s = { frames: [], longTasks: [], on: true, last: performance.now() })
    const tick = (t) => { if (!s.on) return; s.frames.push(t - s.last); s.last = t; requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    s.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) s.longTasks.push(e.duration) })
    s.po.observe({ type: 'longtask' })
  },
  stop() {
    const s = this.s
    s.on = false
    s.po.disconnect()
    const f = s.frames.slice(1).sort((a, b) => a - b)
    const at = (p) => f[Math.min(f.length - 1, Math.max(0, Math.ceil(p * f.length) - 1))] ?? 0
    return { frames: f.length, p50: at(0.5), p95: at(0.95), max: f.at(-1) ?? 0, over20: f.filter((x) => x > 20).length, longTaskMax: Math.max(0, ...s.longTasks), longTaskTotal: s.longTasks.reduce((a, b) => a + b, 0) }
  },
}`
