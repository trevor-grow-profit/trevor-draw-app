import type { CustomScheme } from 'electron'

/**
 * The privileged `app://` scheme both origins are served on (`app://yaseen`, `app://drawio`).
 * `standard` gives a real origin (history API, relative URLs), `secure` treats it like https —
 * VS Code (vscode-file://) and Obsidian (app://obsidian.md) do the same. `codeCache` (YAZ-2073 D13):
 * Chromium persists compiled V8 code only for http(s) unless a standard scheme opts in, so without
 * it every launch recompiled the whole renderer and draw.io from source. The cache lives at
 * Chromium's default place, `<userData>/Code Cache`, and manages its own size.
 */
export const APP_SCHEME: CustomScheme = { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }
