import { sepOf, trimSep } from './paths'

/**
 * WHERE EXCALIDRAW'S FONTS COME FROM (YAZ-878, YAZ-2073 3C) — one rule for the build config, main's
 * share upload and the tools. The renderer serves them from its own origin, under
 * `EXCALIDRAW_ASSET_DIR` beside its bundle; the build copies the package's own `fonts/` tree there,
 * and dev reads that tree wherever npm hoisted it. Pure strings: each caller brings its own `fs`.
 */

/** The folder beside the renderer bundle Excalidraw's assets are served from (`client/src/drawings/engine.ts` points the engine at it). */
export const EXCALIDRAW_ASSET_DIR = 'excalidraw-assets'

/** The package's `fonts/` tree under each place npm may have installed it from `repo` — the root first, then `client/` — in that order. */
export function excalidrawPackageFonts(repo: string): string[] {
  const sep = sepOf(repo)
  const under = (base: string) => [base, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts'].join(sep)
  return [under(trimSep(repo)), under(`${trimSep(repo)}${sep}client`)]
}
