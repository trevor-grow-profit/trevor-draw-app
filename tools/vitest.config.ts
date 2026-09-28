import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The `tools/` project: the build, pack, seed and perf scripts are plain ESM run straight by node,
 * so their suites are `.mjs` too and drive the real code against real temp dirs and the real
 * `git` / `hdiutil`. `@shared` resolves for the app modules some suites import (`drawioProtocol.ts`).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  test: {
    name: 'tools',
    environment: 'node',
    include: ['*.test.mjs', 'perf/*.test.mjs'],
    testTimeout: 60_000,
  },
})
