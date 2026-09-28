# engine-upstream-perf: upstream Excalidraw performance fixes in the fork, and the cherry-pick plan

Scratch dir: `$SCRATCH/engine-upstream-perf/`. The scratch clone is `fork/` and the result branch is **`perf/upstream-cherry-picks`**. `patches/0001..0005-*.patch` is the same branch as `git format-patch` output. The original fork (`~/Documents/GitHub/yaseen-excalidraw` @ e72242f8) was not touched: its status is clean and HEAD is unchanged.

## 1. What I measured

- **Merge-base with upstream master:** `1acf66ed`, "feat(editor): bind text to hovered arrow endpoint (#11777)", dated **2026-07-28**.
  - Commands: `git clone <fork> fork`, then `git remote add upstream …`, `git fetch upstream master` (upstream tip 438d8986, 2026-09-27), then `git merge-base HEAD upstream/master`.
  - The fork is 265 commits ahead of upstream and **55 upstream commits behind**. `git cherry` shows none of the 55 were ported by patch-id.
- **Presence check:** `git merge-base --is-ancestor <upstream sha> HEAD` for every listed PR, plus every upstream commit since 2024-06 whose subject or body matches perf|performance|slow|lag|cache|optimi|faster|speed|jank|memo.
  - I also grepped the fork's current code for each "present" PR, to confirm the fork's own changes had not reverted them:
    - `imageCrop` cache key: renderElement.ts:149/274/677
    - `cachedHit` in collision.ts:183
    - `shouldApplyFrameClip` in staticScene.ts:334
    - `eraser/index.ts` exists
    - `applyDarkModeFilter` is used 8 times in renderElement.ts
- **Benchmarks:** vitest in the scratch clone, Node 26, median of 10 warm steps, base e72242f8 vs the branch. The test files were temporary and have been deleted.

| Benchmark | Base e72242f8 | Branch | Speed-up |
|---|---|---|---|
| `dragSelectedElements`, 1k selected rectangles | 34.1 ms/step | 1.7 ms | 20× |
| `dragSelectedElements`, 2k selected rectangles | 121.6 ms/step | 3.2 ms | 38× |
| `dragSelectedElements`, 4k selected rectangles | **524.9 ms/step** | **6.5 ms** | **80×** |
| resize pattern (`updateBoundElements` × n, shared array), 1k / 2k / 4k | 30.4 / 112.9 / 502.8 ms | 0.1 / 0.2 / 0.2 ms | ~2500× |
| fork-only frame drag, where a frame carries what is inside it (dragElements.ts:100-122), 1k / 4k | 0.5 / 1.0 ms | n/a | not a problem |

- **Dark-mode colour check:** I compared JS `applyDarkModeFilter` with the exact CSS `invert(93%) hue-rotate(180deg)` matrix. Results:
  - `#ffffff` → js `#121212`, css `#121212`
  - `#6965db` → js `#8986eb`, css `#8a86ec` (within 1/255)
  - `#3530c4` → js `#b4b0ff`, css `#b4b0ff`
- **Verification on the branch:**
  - `tsc`: clean.
  - `eslint --max-warnings=0` and `prettier --list-different` on every touched file: clean.
  - `yarn build:packages`, which packEngine uses: exit 0.
  - Full `vitest run`: 226 of 228 files pass. 2931 tests pass, 11 fail, and **all 11 failures happen on base e72242f8 too**:
    - `worker/imageStudio.test.ts`: 10 of 16 fail on base (network/environment).
    - The adapted drag test: it fails on base because it asserts the new behaviour and relies on upstream's text fixture. On the branch it passes 7/7 after commit 0005.

## 2. PR status table

| PR (upstream sha) | Status in fork | Cherry-pick result | Visual change? | Expected speed win |
|---|---|---|---|---|
| #8697 image crop cache key (958e03fc, 2024-10) | **Present** | n/a | none (already shipping) | already had |
| #10578 JS dark-mode colours, static canvas (63e11482, 2026-01) | **Present** | n/a | none vs today. The app already renders this way: static canvas unfiltered, colours through `applyDarkModeFilter`, only SVG images inverted (renderElement.ts:408-463). | already had |
| #10648 collision hit cache (dfdd994d, 2026-01) | **Present** | n/a | none | already had |
| #8980 fewer frame clippings (dd1b45a2, 2025-01) | **Present** | n/a | none | already had |
| #9352 eraser rewrite (58f7d33d, 2025-04) | **Present** | n/a | none | already had |
| #12180 id-set cache on multi-resize (84e3f5a4, 2026-09-27) | **Missing** | **Clean** | none | multi-element resize/rotate/align/distribute: O(n²) → O(n). 4k elements: 503 → 0.2 ms per pointer move in the bound-element update. |
| #12183 id-set reuse on drag (74423812, 2026-09-27) | **Missing** | **1 trivial conflict**: import line in `packages/element/src/dragElements.ts`. The fork added `getElementBounds` (GRO-1958); I kept both imports. The upstream test needed a fixture adaptation (commit 0005). | none | dragging many selected elements. 4k: **525 → 6.5 ms/step** (upstream measured in-app 643 → 54 ms/frame). |
| #12050 JS dark-mode colours, interactive canvas (f1a79b73, 2026-09-07) | **Missing** | **1 trivial conflict**: import block in `packages/excalidraw/lasso/index.ts`. The fork added a `getContainerElement` import; I kept both. **It also needs a fork fixup commit (0004), or dark mode changes.** | **Yes, without the fixup (see §3).** With fixup 0004, none (≤1/255 rounding). | Removes the full-viewport `filter: invert() hue-rotate()` pass on the canvas that repaints on every pointer move, dark mode only. Upstream measured 40 → 120 fps under software compositing. In Electron with GPU compositing (the app sets no GPU-disabling flags; `git grep disableHardwareAcceleration` finds nothing) the gain is smaller. I did not measure it in the app, so treat it as a dark-mode drag/marquee smoothness gain that is large only when Chromium falls back to software compositing. |
| #12063 snap bitmaps/scroll/grid to device pixels (6574de60, 2026-09-09) | **Missing** | **Clean**, tried on `scratch/try-12063`. | **Yes, intentionally:** element bitmaps, scroll and grid are rounded to whole device pixels. This shifts elements by up to 0.5 device px and fixes doubled or broken glyph rows on half-pixel labels. Not a perf PR. | ~0. It is a crispness fix. |
| Other 2024-06…2026-09 perf commits: #8198, #8267, #8340, #8429, #8490, #8763, #8784/#8788/#8770 (build flags), #9060, #9086, #9512, #9572, #9624, #9946, #11332, #11604, #11630, #11637 | **All present** (ancestors of HEAD) | n/a | none | already had |
| Other missing upstream commits that mention caches: #12082 (text tool), #12100 (renderOverrides culling), #12064 (sticky notes), #12124 | Missing | not attempted | These are feature PRs. The perf parts are internal to new features and are not standalone fixes. | none for existing features |

## 3. Visual differences #12050 would introduce in this fork (all fixed in commit 0004)

1. **Fork-only smart-shape handles** (`packages/excalidraw/renderer/smartShapeHandles.ts:14-15`, hard-coded `#ffffff` / `#6965db` on the interactive canvas).
   - Today in dark mode the CSS invert shows them as fill `#121212` and stroke `#8a86ec`.
   - After #12050 alone they would render as **bright white dots with `#6965db` rings**.
   - Fix: map both colours through `applyDarkModeFilter` when the theme is dark, which reproduces the old values.
2. **Lasso trail** (SVG layer, never filtered).
   - Today it is `rgb(105,101,219)` in both themes.
   - Upstream moved it to `--color-selection`, so in dark mode it would become **`#b4b0ff`** (a lighter lavender).
   - Fix: keep the hard-coded purple.
3. **The fork's DOM text-selection highlight** (`styles.scss:48-50`, `.excalidraw-wysiwyg-selection { color-mix(var(--color-selection) 35%) }`). The overlay is appended at textWysiwyg.tsx:1630 and has no filter.
   - Upstream changed dark `--color-selection` from `#3530c4` to `#b4b0ff`, so the dark-mode text selection would go from **dark indigo at 35%** to **light lavender at 35%**.
   - Fix: add `--color-wysiwyg-selection: #3530c4` in the dark theme and use it with a fallback to `--color-selection`.
4. **Collaborator cursor colours** (upstream's intentional change).
   - I checked for collaborator use in the draw app: `git grep collaborators|isCollaborating` in client/share/shared/desktop found nothing. Unreachable in Yaseen Draw, so no change.
5. **Everything else upstream themed** (selection boxes, handles, binding highlights, snaps, scrollbars, search highlights, marquee) keeps the exact former post-filter values.
   - I found no remaining hard-coded colours on the interactive canvas except debug-only `#c92a2a` (renderElement.ts:799, env-gated) and `clients.ts:112` (collab only).
   - The draw app does not override `--color-selection` or `--theme-filter` (checked with `git grep`).

Commit 0004 as a diff (branch `perf/upstream-cherry-picks`, 328baed7):

```diff
--- a/packages/excalidraw/renderer/smartShapeHandles.ts
+++ b/packages/excalidraw/renderer/smartShapeHandles.ts
@@ -1,18 +1,23 @@
+import { THEME, applyDarkModeFilter } from "@excalidraw/common";
 import { getSmartShapeHandles } from "@excalidraw/element";
-import type { Zoom } from "../types";
+import type { AppState, Zoom } from "../types";
 export const renderSmartShapeHandles = (
   context: CanvasRenderingContext2D,
   element: ExcalidrawLinearElement,
   zoom: Zoom,
+  theme: AppState["theme"],
 ) => {
+  const isDark = theme === THEME.DARK;
-  context.fillStyle = "#ffffff";
-  context.strokeStyle = "#6965db";
+  context.fillStyle = applyDarkModeFilter("#ffffff", isDark);
+  context.strokeStyle = applyDarkModeFilter("#6965db", isDark);
--- a/packages/excalidraw/renderer/interactiveScene.ts
+++ b/packages/excalidraw/renderer/interactiveScene.ts
@@ -2015 +2015,6 @@
-          renderSmartShapeHandles(context, selectedElements[0], appState.zoom);
+          renderSmartShapeHandles(context, selectedElements[0], appState.zoom, appState.theme);
--- a/packages/excalidraw/lasso/index.ts
+++ b/packages/excalidraw/lasso/index.ts
@@ -69,9 +63,10 @@
-      fill: () => setColorAlpha(getSelectionColor(app.interactiveCanvas), 0.05),
-      stroke: () => getSelectionColor(app.interactiveCanvas),
+      fill: () => "rgba(105,101,219,0.05)",
+      stroke: () => "rgba(105,101,219)",
--- a/packages/excalidraw/css/theme.scss
+++ b/packages/excalidraw/css/theme.scss
@@ -229,0 +230,3 @@
     --color-selection: #b4b0ff;
+    --color-wysiwyg-selection: #3530c4;
--- a/packages/excalidraw/css/styles.scss
+++ b/packages/excalidraw/css/styles.scss
@@ -49 +49,5 @@
-    background: color-mix(in srgb, var(--color-selection) 35%, transparent);
+    background: color-mix(in srgb, var(--color-wysiwyg-selection, var(--color-selection)) 35%, transparent);
```

## 4. Recommended ordered cherry-pick list

This is exactly branch `perf/upstream-cherry-picks` on top of e72242f8. It touches 14 files, +440 / −94.

1. `git cherry-pick -x 84e3f5a4`: #12180. Clean.
2. `git cherry-pick -x 74423812`: #12183. Resolve the import in dragElements.ts by keeping `getElementBounds` next to `getCommonBounds`.
3. `git cherry-pick -x f1a79b73`: #12050. Resolve the import in lasso/index.ts by keeping `getContainerElement`.
4. Fork fixup 328baed7: keeps the dark-mode look identical (§3).
5. Fork test fixup 63473eb5: the upstream test asserted the label at x=30. The fork's `API.createElement` anchors centred text so that it starts at x=-10. The drag itself is correct (+20).

To apply to the real fork, run `git am $SCRATCH/engine-upstream-perf/patches/*.patch` on a branch off e72242f8, then `node tools/packEngine.mjs` in the draw-app repo.

**Leave out: #12063.** It is not a performance fix and it changes rendering by design (§5).

## 5. Risk and how to prove no regression

- **#12180 / #12183**
  - The id set is cached per array in a WeakMap. The risk is a caller that mutates the array after the first call. I audited all 9 `simultaneouslyUpdated` call sites in the fork (resizeElements.ts:604/1645, dragElements.ts:179, align.ts:47, distribute.ts:81/109, App.tsx:6085, Stats/utils.ts:229). Every one builds its array per operation and does not mutate it afterwards.
  - Proof: the new upstream `dragElements.test.ts` (7 tests: bindings, unbinding, frames with children, grouped labels, unchanged coordinates) passes, and the full suite has no new failures.
  - Manual check: drag and resize 4k rectangles with bound arrows. Arrows still follow, and arrows unbind when dragged alone.
- **#12050 + fixup**
  - Risk: any fork or host colour on the interactive canvas that relied on the CSS invert. I grepped every fork-added `fillStyle`/`strokeStyle` line (`git diff 1acf66ed e72242f8`); only smartShapeHandles.ts qualified, and it is fixed.
  - Proof, manual dark-mode A/B screenshots of the current app vs a rebuilt engine:
    - smart-shape handles
    - selection box, transform handles and group selection
    - locked selection
    - binding highlight on an arrow endpoint
    - snap lines
    - lasso trail
    - text selection inside styled/bulleted text (wysiwyg overlay)
    - scrollbars
    - element search highlights
  - Expect pixel parity within 1/255.
- **Merge debt:** 5 commits on top of the fork. A future full upstream sync will see these as already applied (cherry-pick -x records the upstream shas). Only the 0004 fixup lines could conflict.

## ARCHITECTURE DECISIONS FOR YASIN

**A. Upstream's intentional dark-mode changes in #12050**
- **Problem:** #12050 deliberately recolours the lasso trail and the dark `--color-selection` token, which also feeds the fork's text-selection highlight. The rule is that nothing may change how things look.
- **Options:**
  1. Keep today's look with the fixup (branch default).
  2. Accept upstream's look: the lasso matches the marquee (lavender in dark mode) and the text selection turns lighter.
- **Recommendation:** 1. It follows the no-visual-change rule and costs 3 small lines. Option 2 can be revisited later as a deliberate design change.

**B. #12063 (device-pixel snapping)**
- **Problem:** It is a real crispness fix (no more doubled or broken glyph rows on half-pixel labels), but it moves rendering by up to 0.5 device px and rounds scroll. That is a visible change, and it brings no speed.
- **Options:**
  1. Skip it.
  2. Adopt it as a separate "rendering crispness" issue with its own A/B visual review.
- **Recommendation:** 1 for this project, 2 as an optional later item. It cherry-picks cleanly (`scratch/try-12063`).

**C. How to stay current with upstream perf work**
- **Problem:** The fork is 55 commits behind upstream (2 months). Most of those are features: sticky notes, compact styles panel, text-tool rework and others, which would change UI.
- **Options:**
  1. Cherry-pick perf-only commits, as done here.
  2. Do a full upstream merge.
- **Recommendation:** 1. A full merge would bring feature and UI changes the rule forbids.

## EXECUTION ISSUE CANDIDATES

1. **Engine: port upstream drag/resize O(n²) fixes (#12180, #12183).** Commits 0001, 0002 and 0005. Acceptance:
   - 4k-selection drag step at or below 10 ms in the vitest bench (today 525 ms).
   - Suite green except the known imageStudio failures.
2. **Engine: port #12050 (no CSS filter on the interactive canvas) with the dark-mode parity fixup.** Commits 0003 and 0004. Acceptance: the dark-mode A/B screenshot checklist in §5 shows pixel parity.
3. **Draw app: bump the vendored engine to the new fork commit** (`node tools/packEngine.mjs --commit <sha>`). Re-check the engine-owned selectors named in the packEngine header, and run the app test suite and a manual drag/dark-mode check in the packaged app.
4. **(Optional, needs decision B) Rendering crispness: adopt #12063 behind an A/B review.**
5. **(Optional) Measure the Electron dark-mode frame time before/after #12050** with a Performance trace of a marquee drag over a full canvas. This replaces the upstream-reported number with our own.
