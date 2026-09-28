import { basename, stripExt } from './paths'

export const APP_NAME = 'Yaseen Draw'

/**
 * Obsidian-style window title (C3, GRO-2165): `<file> — <vault>` (vault extension stripped),
 * the vault alone with no file open, the app name on the Welcome screen (no vault). `vault` is
 * the vault's NAME — its display name or folder name (Docs YAZ-1974 D4), never its path.
 */
export function windowTitle(vault: string | null, file: string | null): string {
  if (vault === null) return APP_NAME
  if (file === null) return vault
  return `${stripExt(basename(file))} — ${vault}`
}
