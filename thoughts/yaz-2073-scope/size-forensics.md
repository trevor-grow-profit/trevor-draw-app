# size-forensics — byte-level audit of what WE ship (app.asar + share-viewer + DMG)

Angle owner: size-forensics. Packaged v0.1.11 arm64 (`desktop/dist-app/mac-arm64/Yaseen Draw.app`). Repo untouched; all work in `$SCRATCH/size-forensics/`.

## 1. What I measured (commands + numbers)

- `npx @electron/asar extract Resources/app.asar $SCRATCH/size-forensics/asar` → 3,051 files, 75.12 MB of file bytes (asar file 75.97 MB; +1.5 MB is electron-builder's integrity header).
- `cp -R Resources/share-viewer $SCRATCH/size-forensics/sv` → 430 files, 23 MB.
- `shasum` over both trees → duplicate groups; `node cmp.js` → raw vs brotli-9 per category; `esbuild --minify --charset=utf8` per renderer chunk (Vite's own minifier + charset) → minified size.
- DMG: `hdiutil convert <real 0.1.11 dmg> -format ULMO|UDBZ`; `hdiutil create -srcfolder … -format UDZO|ULFO|ULMO|UDBZ` on the baseline and on two simulated optimized .app copies (A, B below). Mount-tested the ULMO image (`hdiutil attach` 7 s, contents intact).

### Size tree (raw bytes)

| Where | MB | What |
|---|---|---|
| asar `out/drawio` | 51.5 | draw.io webapp: `js/` 29.8 (app.min 9.5, stencils.min 7.5, viewer-static 4.1, extensions 3.9, shapes 1.5, plantuml 0.9, libavoid 0.6, gliffy 0.6, orgchart 0.5), `img/` 11.7 (1,746 svg 5.15 + 348 png 1.69), `templates/` 5.6, `math4/` 3.3, `yaseen-fonts/` 0.49 |
| asar `out/renderer/assets` | 14.7 | 125 JS chunks + 2 CSS, **UNMINIFIED** (mermaid/cytoscape/katex/codemirror/app code; Excalidraw's own `dist/prod` is already minified). Entry `index-kGzVaEUc.js` 0.97 MB; 54 Excalidraw locale chunks 1.52 MB; `subset-shared` 1.84 MB (1.76 MB is base64 harfbuzz/woff2 wasm) |
| asar `out/renderer/excalidraw-assets/fonts` | 13.56 | 243 woff2, incl. **Xiaolai (CJK) 12.67 MB / 209 unicode-range shards** |
| asar `node_modules/{chokidar,readdirp}` | 0.17 | **load-bearing** (see F6) |
| asar `out/main` + `preload` | 0.30 | main unminified (5,693 lines) |
| `share-viewer/fonts` | 13.7 | **byte-identical copy** of `excalidraw-assets/fonts` |
| `share-viewer/{viewer.js,chunks/}` | 9.58 | minified esbuild build of the same Excalidraw+mermaid+katex+codemirror; 54 locale chunks 2.07 MB (ASCII-escaped) |
| Framework `Resources/*.lproj/locale.pak` | 48.66 (220 files, 56 unique) | Chromium UI strings, 55 languages × {plain, FEMININE, MASCULINE, NEUTER} (not "ours", but electronLanguages was in scope) |
| App `Contents/Resources/*.lproj` (55) | 0 | empty dirs — cost nothing |

- No `.map`, no `.d.ts`, no tests in either tree (YAZ-1973's prune + electron-builder defaults already cover it). Only stray docs: `drawio/resources/{README,CONTRIBUTING}.md`, `js/libavoid-js/{README,CLAUDE}.md` ≈ 10 KB — ignore.
- Brotli-9 of all 98.58 MB (ours) = 52.78 MB → roughly half our bytes are already-compressed (woff2, png, base64 wasm).

### Duplicates (sha1, asar + share-viewer)

- 427 dup groups, **15.23 MB** redundant:
  - 13.56 MB: `renderer/excalidraw-assets/fonts/**` ≡ `share-viewer/fonts/**` (12.67 of it Xiaolai).
  - 0.49 MB: `drawio/yaseen-fonts/**` ≡ a subset of the same Excalidraw fonts (third copy).
  - 0.90 MB: draw.io's own `img/computers|networking/*.png` ≡ `img/lib/clip_art/**` (177 groups; path-addressed by old diagrams).
  - 0.16 MB: Assistant woff2 ×4 copies (renderer/assets, excalidraw-assets, sv/files, sv/fonts).

### DMG (download) formats

| Image | Bytes | Δ vs shipped | Build time |
|---|---|---|---|
| Shipped 0.1.11 (electron-builder UDZO zlib-9) | 172.48 MB | — | — |
| `hdiutil convert` → **ULMO (lzma)** | **138.90 MB** | **−33.6 MB (−19.5%)** | 14 s |
| `hdiutil convert` → UDBZ (= `compression: "maximum"`) | 160.46 MB | −12.0 MB | 8 s |
| ULFO (lzfse) (fresh create, same harness as UDZO 178.3) | 177.4 MB | ≈ −0.5% | 8 s |

### Simulated end-states (real .app copies, same hdiutil harness; harness baseline UDZO 178.3 / ULMO 146.2)

| Variant | Installed (du) | UDZO | ULMO |
|---|---|---|---|
| Baseline | 371 MiB | 178.3 MB | 146.2 MB |
| **A** = renderer minified + share-viewer fonts deduped + sv `charset:utf8` + no node_modules | 350 MiB (−21) | 159.9 | 129.2 |
| **B** = A + Chromium locales trimmed to `en` | 304 MiB (−67) | 147.7 | 117.8 |

- Scaled to electron-builder's real image (real/harness ≈ 0.95 for ULMO): **A ≈ 123 MB, B ≈ 112 MB DMG** (from 172.5).
- Floor check: in B, `Frameworks/` alone compresses to **80.6 MB ULMO**; all our Resources to **38.6 MB**. After this angle, ~68% of the download is Electron itself.

## 2. Findings ranked by impact

| # | Finding | Installed Δ | DMG Δ | Class |
|---|---|---|---|---|
| F1 | DMG is zlib UDZO; lzma ULMO is 19.5% smaller | 0 | **−33.6 MB** | pure packaging |
| F2 | share-viewer ships a 2nd byte-identical copy of all Excalidraw fonts | **−13.7 MB** | **≈ −13.5 MB** | pure waste (dedupe) |
| F3 | Renderer JS/CSS never minified (electron-vite 5 default `minify:false`) | **−5.29 MB** | −0.6 MB | pure waste; also a parse-time win (entry 0.97→0.41 MB) |
| F4 | Chromium locale.pak ×220 | −48.7 MB | −11.4 MB | **decision** (D1) |
| F5 | share-viewer esbuild emits ASCII-escaped non-Latin text | −0.65 MB | ~0 | pure waste |
| F6 | chokidar is NOT bundled, contrary to config comment + CONTRACTS | −0.17 MB | ~0 | correctness drift |
| F7 | `drawio/yaseen-fonts` third font copy | −0.49 MB | −0.49 MB | restructure (alias) |
| F8 | draw.io intra-dup images | 0.9 MB | ~0.3 | **do not do** (below) |

### F1 — DMG compression (−33.6 MB download)
- Evidence: `hdiutil imageinfo` → "UDIF read-only compressed (zlib)"; `node_modules/dmg-builder/out/dmg.js:122-131` picks UDZO unless `compression:"maximum"` (→ UDBZ). `app-builder-lib/scheme.json:975-982` enum excludes `ULMO`, though the bundled dmgbuild supports it (`dmgbuild/core.py:887` `"ULMO": "lzma"`) — so it has to be a post-step, not a config value.
- ULMO needs macOS 10.15+; Electron 43 needs macOS 12+, so no user loses anything. Release workflow uploads only `desktop/dist-app/*.dmg` (`.github/workflows/release.yml:26`); nothing consumes `.blockmap` (no electron-updater in repo).
- Change (`tools/packDesktop.mjs`, after line 27):
```diff
@@ tools/packDesktop.mjs:10-27 @@
-import { execFileSync } from 'node:child_process'
-import { readFileSync } from 'node:fs'
+import { execFileSync } from 'node:child_process'
+import { readFileSync, renameSync, rmSync } from 'node:fs'
 ...
 execFileSync(npm, ['exec', '-w', 'desktop', '--', 'electron-builder', ...args, `-c.extraMetadata.version=${version}`], {
   cwd: root,
   stdio: 'inherit',
   shell: process.platform === 'win32',
 })
+
+/**
+ * The Mac image, recompressed zlib → lzma (ULMO, macOS 10.15+; Electron 43 needs 12+): −19.5 % download,
+ * same volume, layout and signed .app. electron-builder's schema has no ULMO, so it is a post-step.
+ * The .blockmap described the zlib image and nothing reads it (no auto-updater), so it goes.
+ */
+if (args.includes('--mac')) {
+  const dmg = join(root, 'desktop', 'dist-app', `Yaseen Draw-${version}-arm64.dmg`)
+  const tmp = `${dmg}.ulmo.dmg`
+  rmSync(tmp, { force: true })
+  execFileSync('hdiutil', ['convert', dmg, '-format', 'ULMO', '-o', tmp], { stdio: 'inherit' })
+  execFileSync('hdiutil', ['verify', tmp], { stdio: 'inherit' })
+  renameSync(tmp, dmg)
+  rmSync(`${dmg}.blockmap`, { force: true })
+}
```
- Zero-code alternative: `"dmg": { "format": "UDBZ" }` → −12 MB only.
- Risk: none to features. Proof: `hdiutil imageinfo` shows lzma; `hdiutil verify`; mount → drag to /Applications → launch; `codesign --verify --deep --strict` on the installed app (convert does not touch the .app bytes).

### F2 — share-viewer font duplicate (−13.7 MB installed and download)
- Evidence: `tools/buildShareViewer.mjs:65` copies `@excalidraw/excalidraw/dist/prod/fonts` into `share/dist/assets/fonts`; `desktop/electron.vite.config.ts:53-55` copies the **same** tree into `out/renderer/excalidraw-assets/fonts`; `desktop/package.json:30-35` ships the former as extraResources. sha1: 243/243 files identical.
- Precedent already in the code: draw.io files are NOT copied into share-viewer; `readViewerAssets` publishes them from the asar (`desktop/src/main/ipc/share.ts:41-62`, `drawio/assets.ts:36-43`). Apply the same pattern to fonts. The published manifest does not change (`/assets/fonts/<same path>`, same bytes).
- Change:
```diff
@@ tools/buildShareViewer.mjs:65 @@
-  fs.cpSync(path.join(pkgDir('@excalidraw/excalidraw'), 'dist', 'prod', 'fonts'), path.join(OUT, 'fonts'), { recursive: true })
+  // fonts/ is NOT copied: share setup publishes /assets/fonts/… from the app's one copy (readViewerAssets).
@@ desktop/src/main/ipc/share.ts:48,59-62 @@
-export async function readViewerAssets(dir: string, drawioDir: string): Promise<AssetFile[]> {
+export async function readViewerAssets(dir: string, drawioDir: string, fontsDir: string): Promise<AssetFile[]> {
 ...
   const own = await filesUnder(dir, dir, '/assets/')
+  const fonts = await filesUnder(fontsDir, fontsDir, '/assets/fonts/')
   const drawioFiles = DRAWIO_SHARE_FILES.map(…)
   const drawioDirs = …
-  return Promise.all([...own, ...drawioFiles, ...drawioDirs].map(…))
+  return Promise.all([...own, ...fonts, ...drawioFiles, ...drawioDirs].map(…))
@@ desktop/src/main/ipc/share.ts:89 @@
-    readAssets: () => readViewerAssets(where.viewerAssetsDir, where.drawioDir),
+    readAssets: () => readViewerAssets(where.viewerAssetsDir, where.drawioDir, where.fontsDir),
@@ desktop/src/main/index.ts:213-217 @@
     viewerAssetsDir: viewerAssetsDir({ … }),
     drawioDir: DRAWIO_DIR,
+    // packaged: out/renderer/excalidraw-assets/fonts inside the asar; dev: the package's own dist/prod/fonts
+    fontsDir: resolveExcalidrawFontsDir({ mainDir: __dirname, appPath: app.getAppPath(), isPackaged: app.isPackaged, exists: existsSync }),
     isPackaged: app.isPackaged,
```
  - New `resolveExcalidrawFontsDir` beside `resolveDrawioDir` (`drawio/assets.ts:58`) — same shape: packaged → `path.resolve(mainDir,'..','renderer','excalidraw-assets','fonts')`; dev → first existing of `<repo>/node_modules/…/dist/prod/fonts`, `<repo>/client/node_modules/…`.
  - `tools/fakeCloudflare.mjs:150-153`: add a `/assets/fonts/` fallback to the same package dir (the pre-setup demo path).
  - Update `docs/CONTRACTS.md:1323-1327` and `share.test.ts` / `buildShareViewer.test.mjs` for the new third source.
- Reading recursively from inside the asar is already proven by `drawioDirs` (`img/`, `math4/` live in the asar when packaged).
- Risk: a share missing fonts (CJK text renders in fallback). Proof: a test that the `path → sha256` set returned by `readViewerAssets` is **identical** before/after for the packaged layout; fakeCloudflare demo (`seedShareDemoVault`) with a scene holding Latin + CJK text, all `/assets/fonts/*` 200s; packaged share setup against the fake API.

### F3 — Renderer not minified (−5.29 MB, and faster parse)
- Evidence: electron-vite 5 hard-codes `minify: false` for the renderer (`node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js:536`); `desktop/electron.vite.config.ts:111` does not override it. Output: `cynefin-*.js` 1.30 MB / 32,093 lines, `cytoscape.esm` 0.96 MB, entry `index-kGzVaEUc.js` 0.97 MB / 21,339 lines.
- Measured with Vite's own minifier (esbuild, `charset:utf8` as Vite 7 sets it, `vite/dist/node/chunks/config.js:32194`): **14.68 → 9.39 MB JS+CSS (−36%)**; entry chunk **0.97 → 0.41 MB**; gzip 3.52 → 2.91 MB.
```diff
@@ desktop/electron.vite.config.ts:111 @@
-    build: { outDir: rendererOut, rollupOptions: { input: resolve(client, 'index.html') } },
+    // electron-vite 5 defaults the renderer to minify:false; Vite's esbuild minifier (utf8 charset, CSS too)
+    // cuts the renderer 14.7 → 9.4 MB and the entry chunk 0.97 → 0.41 MB that parses on every window open.
+    build: { outDir: rendererOut, minify: 'esbuild', rollupOptions: { input: resolve(client, 'index.html') } },
```
- Leave main/preload unminified (0.3 MB; readable crash stacks are worth more).
- Risk: code depending on `Function.name`/class names. Grep of `client/src` + `shared` found none (`constructor.name`, `.name === '…'` only on data). Mermaid ships its own `__name` keepNames helper. Excalidraw was already minified. Proof: `npm test` + `npm run typecheck`; packaged smoke of every lazy chunk family — open .excalidraw with text, Mermaid→Excalidraw, a KaTeX/math element, the code editor (CodeMirror), image studio (pica), a .drawio file, export PNG/SVG (font subsetting worker). Optional: temporarily set `build.sourcemap:'hidden'` for one build to prove stacks still map.

### F4 — Chromium locales (−48.7 MB installed / −11.4 MB DMG) → decision D1
- Evidence: `Frameworks/Electron Framework.framework/Resources/*.lproj/locale.pak` = 220 files, 48.66 MB raw, 12.46 MB gzip. The app is English-only: `ExcalidrawSurface.tsx:84` drops `langCode`, draw.io is `lang=en` (`drawioPack.mjs:170`), dates are fixed `'en'`/`'en-US'` (`client/src/lib/format.ts:2`, `relativeTime.ts:7`), and the spellcheck menu is custom (`desktop/src/main/menu.ts:207-212`) using macOS's own spellchecker.
- What the paks still localize: Chromium-drawn strings only (form validation bubbles, `<input type=file|date|color>` UI, some a11y strings). The empty app `Resources/*.lproj` dirs are what make AppKit (Open/Save panels, Services/Emoji/Dictation menu items) follow the OS language. `electronLanguages: ["en"]` removes **both**, which changes Open/Save panels for non-English users → hence a decision, not a fix.

### F5 — share-viewer non-ASCII escaping (−0.65 MB)
- esbuild defaults to `charset: 'ascii'`, so every locale string becomes `\uXXXX`: locale chunks 2.07 → 1.43 MB; all viewer JS 9.58 → 8.93 MB.
```diff
@@ tools/buildShareViewer.mjs:55-56 @@
     minify: true,
+    charset: 'utf8', // as Vite does; ASCII escaping inflated the 54 locale chunks 2.07 → 1.43 MB
     target: 'es2022',
```
- Risk: served without a charset header → mojibake. The Worker/Assets binding serves `.js` as `application/javascript`; ES modules are always decoded as UTF-8 by spec, so this is safe. Proof: share demo with a Russian/Japanese text element, and check the Worker's asset content-type.

### F6 — chokidar ships as node_modules; the config comment and CONTRACTS say it is bundled
- Evidence: `out/main/index.js:9` → `const chokidar = require("chokidar");` — electron-vite 5 externalizes deps **by default** (`lib-q6ns0vZr.js:1636` `config.build?.externalizeDeps ?? true`). So `desktop/electron.vite.config.ts:87-88` ("No externalizeDepsPlugin: chokidar 4 is pure JS and gets bundled") and `docs/CONTRACTS.md:1323-1324` ("the packaged app ships no node_modules") are **false**, and the asar's `node_modules/chokidar` + `readdirp` (0.17 MB) is load-bearing.
- ⚠️ Trap for other agents: moving chokidar to devDependencies **without** the config change breaks file watching in the packaged app.
```diff
@@ desktop/electron.vite.config.ts:86-90 @@
   main: {
-    // No externalizeDepsPlugin: chokidar 4 is pure JS and gets bundled, so the packaged app
-    // needs no node_modules at all (spike decision, see GRO-2151 findings).
+    // chokidar 4 is pure JS: bundle it (electron-vite 5 externalizes deps by default), so the
+    // packaged app needs no node_modules at all (spike decision, see GRO-2151 findings).
     resolve: { alias: { '@shared': shared } },
-    build: { rollupOptions: { input: { index: resolve(here, 'src/main/index.ts') } } },
+    build: { externalizeDeps: false, rollupOptions: { input: { index: resolve(here, 'src/main/index.ts') } } },
   },
@@ desktop/package.json:12-19 @@
-  "dependencies": {
-    "chokidar": "^4.0.3"
-  },
   "devDependencies": {
+    "chokidar": "^4.0.3",
```
- Proof: `npx @electron/asar list app.asar | grep node_modules` is empty; `grep 'require("chokidar")' out/main/index.js` is empty; packaged smoke: add/rename a file in the vault from Finder → the sidebar updates.

### F7 — `drawio/yaseen-fonts` (third font copy, −0.49 MB)
- `tools/lib/drawioPack.mjs:74-85` copies 12 woff2 into the webapp. Instead, `serveDrawio` could map `app://drawio/yaseen-fonts/<f>` → the renderer's `excalidraw-assets/fonts/<f>`, keeping the URL (so the editor's `fontCss`, SVG exports and the share rewrite in `buildShareViewer.mjs:34` all stay the same). Low value; do it only alongside F2.

### F8 — do NOT dedupe draw.io's intra-webapp images (0.9 MB)
- Old diagrams reference `img/computers/…`, `img/networking/…` and `img/lib/clip_art/…` **by path**. Aliasing needs a path map in both `serveDrawio` and share publishing. Cloudflare assets are content-hashed, so the share upload already stores them once. Complexity is not worth 0.9 MB.

### Kept on purpose (features; verified, not waste)
- **Xiaolai CJK, 12.67 MB**: already load-on-demand. 209 shards, each with `unicodeRange` (241 `unicodeRange` in `dist/prod/chunk-HTLLGEU5.js`), so only the shards covering glyphs in a scene are fetched. Fetching them from the network on first use would break the 🔒 offline rule (YAZ-878). The only fix is F2's dedupe; after it they ship **once**.
- draw.io `js/*.min.js`, `img/`, `templates/`, `math4/`, plantuml/gliffy/libavoid: YAZ-1973 already pruned by loader evidence (`tools/lib/drawioPack.mjs:143-174`); everything left is reachable.
- Excalidraw locale chunks (renderer 1.43 MB min, share 1.43 MB): unreachable today (no `langCode`), but removing them means patching the vendored fork. See D4.
- `subset-shared` base64 wasm (1.76 MB): inside the fork's build; as separate `.wasm` it would be ~0.44 MB smaller. Fork-level, low value.

## 3. Projected totals (this angle only)

| | Installed | DMG |
|---|---|---|
| Today | 371 MiB (ours ≈ 99 MB) | 172.5 MB |
| F1+F2+F3+F5+F6 (no product decisions) | ≈ 350 MiB | **≈ 123 MB (−29%)** |
| + D1 (locales, option 2) | ≈ 303 MiB | ≈ 112 MB (−35%) |
| + D2 (share-viewer compressed at rest) | ≈ 296 MiB | ≈ 111 MB |

- Hard truth for "order of magnitude": after all of the above, Electron's framework is 80.6 MB of the ~112 MB DMG and ~230 MiB of the ~300 MiB install. Our own payload can't get the app to 10× smaller. Only a shell change could (see D5).

## 4. ARCHITECTURE DECISIONS FOR YASIN

### D1 — Chromium locale paks (48.7 MB installed / 11.4 MB DMG)
- Problem: we ship Chromium UI strings for 55 languages, but the app UI is English-only.
- Options:
  1. Keep all (today).
  2. **afterPack trim of the framework's `locale.pak` to `en*` only, keeping the 55 empty app `.lproj` dirs.** AppKit panels and menus stay localized; only Chromium-drawn strings (validation bubbles, file/date inputs) fall back to English. It must run in `desktop/build/adhocSign.cjs` BEFORE `codesign`.
  3. `electronLanguages: ["en"]` (one config line). It also removes the app `.lproj` dirs, so Open/Save panels and system menu items turn English for non-English macOS users.
- Recommendation: **2**. It gets the whole 48.7 MB with no visible change in our own UI. The only thing that changes is Chromium widget strings, and those already sit inside an English UI. Option 3 changes OS-drawn UI, which counts as feature loss under your rule.

### D2 — share-viewer at rest (9.4 MB of JS read only during share setup)
- Problem: `Resources/share-viewer` is read only by `readViewerAssets` (setup/re-publish), yet it sits uncompressed on disk.
- Options:
  1. Keep as is (after F2+F5 it is 9.4 MB).
  2. Ship it as one brotli'd tar (≈2.7 MB) and inflate it in main at setup (node zlib).
  3. Unify builds: build the share viewer as a second entry of the renderer's Vite build so the two share chunks, and upload the shared ones. That saves ~9 MB raw, but couples the Worker's assets to the app's chunk graph.
- Recommendation: **1 now, 2 only if installed size becomes a KPI**. The DMG already compresses it (gain ≈0.3 MB download), and option 3's coupling isn't worth it.

### D3 — Compress draw.io at rest in the asar (51.5 MB → ~24 MB brotli)
- Problem: the draw.io webapp is the biggest thing we own. Its JS/SVG compresses 3×.
- Options:
  1. Keep raw (today).
  2. Store `.br` files and have `serveDrawio` decompress per request (app.min.js 9.5 MB ≈ 20-30 ms extra CPU on every editor open, unless cached in memory).
- Recommendation: **1**. The download gains ~0 (the DMG is already lzma), installed saves ~27 MB, and it costs editor-open latency — the wrong trade for a "faster" project.

### D4 — Excalidraw's 54 locale chunks (≈1.4 MB × 2 builds, unreachable today)
- Options:
  1. Keep.
  2. Stub `locales/*` imports with a build plugin.
  3. Add a real language setting (turns dead weight into a feature).
- Recommendation: **1**. ~0.8 MB compressed isn't worth patching the vendored fork. Revisit if you ever choose 3.

### D5 — The Electron floor (context for the parent)
- After this angle, the framework is ~72% of the download. A 10× smaller app needs a different shell (system WebView, e.g. Tauri/WKWebView), which is a platform rewrite with its own stability risk. This is out of scope for size-forensics and is flagged so the synthesis doesn't promise 10× from asset work.

## 5. EXECUTION ISSUE CANDIDATES (Linear subissues)

1. **DMG → ULMO post-step** (F1): `tools/packDesktop.mjs` convert + verify + drop blockmap; update LAUNCH/CONTRACTS packaging lines. −33.6 MB DMG. S.
2. **Publish share fonts from the app's one copy** (F2): `readViewerAssets(…, fontsDir)`, `resolveExcalidrawFontsDir`, stop copying in `buildShareViewer.mjs:65`, fakeCloudflare fallback, manifest-equality test. −13.7 MB. M.
3. **Minify the renderer** (F3): `minify:'esbuild'` in `electron.vite.config.ts:111` + packaged smoke checklist of lazy chunks. −5.3 MB, entry parse −57%. S.
4. **share-viewer `charset:'utf8'`** (F5): one line + CJK/Cyrillic share demo check. −0.65 MB. XS. (Can merge into #2.)
5. **Really bundle chokidar; fix the stale comment + CONTRACTS** (F6): `externalizeDeps:false`, move dep to devDependencies, assert no `node_modules` in the asar. Correctness. S.
6. **Trim Chromium locale.pak to en in afterPack** (D1 option 2, only after Yasin's OK): before codesign; verify an Open panel stays localized on a de-DE account. −48.7 MB installed / −11 MB DMG. S.
7. **(Optional) Alias `app://drawio/yaseen-fonts/`** to the renderer fonts (F7). −0.49 MB. XS. Only with #2.
8. **Size guard in CI**: a test/script that fails when `app.asar` or `share-viewer` grows more than X% or when any sha1 duplicate >100 KB appears across the two (the command set in §1). This stops regressions like F2/F3 from coming back. S.
