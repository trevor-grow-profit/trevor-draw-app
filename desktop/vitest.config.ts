import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  test: {
    name: 'desktop',
    environment: 'node',
    // `shared/` has no project of its own; its pure-rule tests (🔒 YAZ-1811 `drawingAssets.test.ts`)
    // run here under node, which is the environment they promise to need nothing more than.
    include: ['src/**/*.test.ts', '../shared/**/*.test.ts', '*.test.ts'],
    // Vitest's 5 s default stands for the files that need nothing more. The two suites that
    // spawn the real `git` binary raise it for themselves (`REAL_GIT_TIMEOUT_MS` in
    // `git/gitFixture.ts`), so a hang anywhere else still fails in five seconds.
  },
})
