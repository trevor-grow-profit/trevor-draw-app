# Main-process findings (Electron main + preload): startup, IPC, file I/O, watchers, sync

Angle: `main-process`. Repo read-only; every measurement ran on copies (vault copies, isolated userData via `YASEEN_DRAW_USER_DATA_DIR`, git remote re-pointed to a local bare clone so nothing reached GitHub).

## TL;DR (ranked)

| # | Finding | Measured impact | Fix size |
|---|---|---|---|
| 1 | **Tree-refresh storm.** Every watcher event makes every window call `fs:tree`, and main runs a full vault walk for each call with no coalescing | 230-file burst on a 2 000-board vault: **33 s main CPU, 3.16 GB main footprint, IPC stalls of up to 1.9 s, a save delayed 13.8 s**. With single-flight coalescing: **0.93 s CPU, 176 MB** | S (main, ~25 lines) + S (client debounce) |
| 2 | **Quit no longer flushes the store or git sync.** The flushes were dropped by accident in 82d63ce. That breaks YAZ-1111 "last sync before quit" and the D9 "write pending state" promise | Edit made 2.5 s before quit: quit took 39 ms, **0 git spawns**, file left ` M` (never committed or pushed) | XS (1 line + test) |
| 3 | No V8 code cache for the `app://` scheme (the `codeCache` privilege is missing) | `Code Cache/js` = 8 KB (empty). With the flag it holds 1.2 MB. dom-ready is ~12 ms sooner and canvas ~20–40 ms sooner (~5 %) | XS |
| 4 | `atomicWrite` never calls fsync. A kernel panic or power loss can leave a renamed board empty or holding stale bytes | Cost of the fix: +5 ms per 3.3 MB save (2.6 ms without fsync, 8.2 ms with) | XS |
| 5 | chokidar 4 on macOS holds **one fd per file and folder** and adds 200–260 ms to every change event | 2 302 files → 2 335 fds, `ready` in 141 ms, change latency 259 ms. `fs.watch(recursive)` on the same vault: 0 extra fds, 0.6 ms setup, 14 ms latency | M (architecture decision) |
| 6 | `drawing:save` parses the whole scene 3 times and stringifies it twice on the main thread | 3.3 MB scene blocks main for 21.4 ms. One parse plus one stringify takes 8.6 ms | S |
| 7 | An idle sync poll spawns 9 git processes every 60 s | ~200 ms wall and ~170 ms CPU per pass. A lean poll (fetch + rev-list) takes ~60 ms | S |
| 8 | Watch-subscription race leaks a chokidar subscription (unsubscribe arrives while `requireDir` is still pending) | Leaks for the lifetime of the window. Triggered by a quick root switch or a React StrictMode remount | XS |
| 9 | Smaller items: identical-content store writes, sequential quit flush per window, stale "chokidar is bundled" comment | — | XS |

The baseline is already lean. On the real vault: ~390 ms to the first page target, ~550–610 ms to canvas, **main footprint 49 MB**, idle CPU 0.33 % main + 0.30 % renderer + 0.32 % GPU. Main has little startup time left to win (items 3 and 6). The main-process gains that count are in **scaling and reliability** (items 1, 2, 4, 5).

---

## 1. What I measured (commands and numbers)

Setup:
- The installed app, run directly with `YASEEN_DRAW_USER_DATA_DIR=$S/ud-*` and `--remote-debugging-port=9334`.
- An APFS-cloned app (`cp -cR`) whose `app.asar` holds a patched `out/main/index.js`. The patch adds timestamps, an ipc/handle timing wrapper, an execFile spy and env toggles (`BENCH_CC`, `BENCH_NOPLUGINS`, `BENCH_COALESCE`).
- Harnesses: `startup.mjs` (CDP polls until `.excalidraw canvas` exists), `stormapp.mjs`, `idlecpu.mjs`, and `bench.cjs` / `storm.cjs` / `fswatch.cjs` run under `ELECTRON_RUN_AS_NODE=1` with the app's own binary (Electron 43.4.1, Node 24.18.1, libuv 1.52.1).
- Vaults:
  - a copy of the real vault `boards-draw-growprofit`: 16 files, 4 boards, sync enabled
  - `synth`: 100 folders × 20 boards (~30 KB each), 300 assets, a 20 MB legacy board with embedded base64 images and a 3.3 MB board with 5 000 elements

**Startup timeline, real vault, warm, ms since process start** (medians of 4–5 runs; other agents were running, so ±30 ms noise):

| mark | ms |
|---|---|
| main module start | ~100 |
| `app ready` | ~155 |
| `new BrowserWindow` → created | 170 → 260 (**constructor ≈ 90–105 ms**) |
| renderer dom-ready | ~400 |
| `drawing:load` answered (14 ms, 32 KB) | ~440 |
| canvas present (CDP) | ~550–610 |

- Toggling `plugins:false` changed nothing (within noise). Turning sync off (no `github.json`) also changed nothing within noise: the 8 adoption git spawns overlap renderer boot but don't delay it measurably.
- `fs:tree` is requested **twice** at startup (mount + watcher `ready`), 10–13 ms each on the real vault.
- `codeCache:true`: dom-ready is 144 ms after window creation vs ~156 ms without; canvas ~567 vs ~610 ms.

**Memory and idle** (real vault, 30 s idle, `footprint`):
- phys_footprint: main **49 MB**, renderer 58 MB, GPU helper 181 MB.
- Main heapUsed is 7.4 MB. RSS figures (main 168 MB) are inflated by shared framework pages; ignore them.
- Idle CPU over 120 s: main 400 ms, renderer 360 ms, GPU 380 ms (~1 % total). Git children add ~170 ms CPU per 60 s poll.
- fds: main 131.

**Scaling** (`synth`, in the real app):
- `fs:tree` response is 663 KB and takes 55–82 ms uncontended.
- Opening the vault ran the orphan sweep. It trashed ~230 unreferenced synthetic assets, which produced 230 `unlink` events and **~230 concurrent `fs:tree` calls, each 5.4–14 s**.
- Main heapUsed reached **996 MB** (footprint 2.8–3.2 GB), with 54 s of main CPU inside 25 s.
- `drawing:save` took **13 768 ms**.
- Note: this benchmark moved ~230 synthetic `<sha1>.png` files (random bytes, ~11 MB) into the user's Trash. They are safe to empty.

**Controlled storm** (`stormapp.mjs`: 230 boards rewritten while the app is open, as in a sync pull):

| | main CPU | main peak footprint | `state:get` probe latency (avg / max) | settle |
|---|---|---|---|---|
| today | **33.1 s** | **3 162 MB** | **527 ms / 1 912 ms** | 10.7 s |
| main-side coalesced `fs:tree` | 0.93 s | 176 MB | 44 ms / 985 ms | ≤3.1 s (harness floor) |

- The same comparison in isolation (`storm.cjs`, 230 simultaneous calls): 7 177 ms → 313 ms wall, 25.5 s → 0.74 s CPU, 3.6 GB → 103 MB peak RSS, worst event-loop block 1 890 ms → 12 ms.

**Micro-benchmarks** (Electron-as-Node):
- `buildTree` on 2 302 files: 47–55 ms.
- Orphan sweep (`referencedAssetIds`) over 2 002 boards: 378 ms, with a longest block of 7 ms. JSON.parse of the 20 MB legacy board takes only 5 ms (base64 strings are cheap).
- One atomic save produces exactly 1 `change` event: tmp files are swallowed by `awaitWriteFinish`, and a burst of saves collapses into one event.
- Git poll pass (9 commands): 200 ms wall per pass on both the real and synth vaults. Lean variant (fetch + rev-list): 61 ms.

**Quit flush proof** (`quitflush.mjs`):
- Launched on the vault copy with sync on, appended to `Test/9-25 Eng Call.excalidraw` from outside, then sent SIGTERM 2.5 s later.
- Quit took 39 ms with no git spawn after the start-up pass. `git status` shows ` M "Test/9-25 Eng Call.excalidraw"`.

---

## 2. Findings with evidence and fixes

### F1: Tree-refresh storm: O(events × files) work in main (biggest scaling risk)

Evidence:
- `client/src/sidebar/Sidebar.tsx:538-545`: every watch event except `error` calls `refresh()` → `api.tree(root)` (🔒 YAZ-1835 D4 "refresh on EVERY change").
- `desktop/src/main/ipc/fs.ts:37-41` → `fs/tree.ts:14-19` → `fs/fsUtils.ts:140-158`: every call is a fresh full walk. On boards it does open + read 1 KB + fstat per file, and all subdirectories run in parallel (`Promise.all`).
- N events × W windows × F files = N·W·F file opens, all in flight at once. Each walk also allocates a ~660 KB tree that is structured-cloned to the renderer.

Consequences: a git pull, `git checkout`, the orphan sweep, "Move pictures out", or a Finder copy of a folder can stall main for seconds.
- While main is stalled, every IPC waits, including `drawing:save` (13.8 s measured).
- **Data-loss path:** if the user quits during a storm, `FLUSH_TIMEOUT_MS = 5000` (`windows.ts:44`) expires. The window is destroyed, then `app.exit(0)` kills the save still queued behind the walks.

Fix A (main, keeps the 🔒 D4 semantics exactly): single-flight per root with one trailing walk. Callers that arrive during a walk share ONE walk that starts after it ends, so every answer is newer than its request. The renderer's `generatedAt` ordering still holds.
```diff
--- a/desktop/src/main/fs/tree.ts
+++ b/desktop/src/main/fs/tree.ts
@@ -14,6 +14,37 @@
-export async function tree(root: string): Promise<TreeResponse> {
-  const dir = requireAbsPath(root, 'root')
+/**
+ * ONE walk per root at a time (YAZ-xxxx). A caller arriving mid-walk joins the single trailing
+ * walk that starts when the current one ends — never the running one, whose snapshot may predate
+ * the change that caused the call. So every answer still post-dates its request (YAZ-1835 D4),
+ * but a burst of N watcher events costs at most 2 walks instead of N concurrent ones.
+ */
+interface Flight { running: Promise<TreeResponse> | null; next: { promise: Promise<TreeResponse>; resolve: (r: TreeResponse) => void; reject: (e: unknown) => void } | null }
+const flights = new Map<string, Flight>()
+
+export function tree(root: string): Promise<TreeResponse> {
+  const dir = requireAbsPath(root, 'root') // throws synchronously → the async IPC handler rejects as before
+  let f = flights.get(dir)
+  if (f === undefined) flights.set(dir, (f = { running: null, next: null }))
+  const flight = f
+  const run = (): Promise<TreeResponse> =>
+    (flight.running = walk(dir).finally(() => {
+      flight.running = null
+      const queued = flight.next
+      flight.next = null
+      if (queued !== null) run().then(queued.resolve, queued.reject)
+      else if (flights.get(dir) === flight) flights.delete(dir)
+    }))
+  if (flight.running === null) return run()
+  if (flight.next === null) {
+    let resolve!: (r: TreeResponse) => void, reject!: (e: unknown) => void
+    const promise = new Promise<TreeResponse>((a, b) => ((resolve = a), (reject = b)))
+    flight.next = { promise, resolve, reject }
+  }
+  return flight.next.promise
+}
+
+async function walk(dir: string): Promise<TreeResponse> {
   await requireDir(dir)
   const nodes = await fsCall(dir, () => buildTree(dir))
```
- The `sweepVaultOnce(res.root, …)` call site in `ipc/fs.ts:38-39` is unchanged.
- Proof: this exact logic was measured in the real app (`BENCH_COALESCE=1`): 33 s → 0.93 s CPU, 3.1 GB → 176 MB.
- Risk: low. Every answer is still a full fresh walk that started after the request. The only change is that duplicate concurrent walks are shared.
- Tests (vitest, fake `buildTree` with deferreds):
  1. A call made during walk 1 resolves with walk 2's result.
  2. 50 calls made during walk 1 cause exactly 1 more walk.
  3. A rejection reaches only that walk's callers, and the next call starts fresh.
  4. Different roots never share a walk.

Fix B (client, pairs with A; report to the renderer angle): a trailing 100–150 ms debounce in the Sidebar's watch subscription, with `ready` refreshing immediately. Main still answers each renderer call, so a 230-event burst still serializes 230 × 660 KB into the renderer. The 985 ms probe max in the coalesced run comes from that.

Fix C (architecture, see D2): a cached, incremental tree index in main.

### F2: The quit sequence silently lost its store flush and git flush (regression)

Evidence:
- `desktop/src/main/index.ts:233-245`: the comment promises "write the pending state" and "the last sync commit contains the edit", but the code is only `manager.flushAllForQuit().finally(() => app.exit(0))`.
- `git log -S"flushForQuit()"` shows commit `82d63ce` (the 2B deletion of the vault index) removed `.then(() => Promise.all([store.flush(), flushIndexCache(), gitSync?.flushForQuit()]))` along with `flushIndexCache`.
- `GitSyncManager.flushForQuit` (`git/manager.ts:419-430`) and `Store.flush` (`store.ts:462-469`) now have **no production caller**.

Consequences:
- **(a) Git.** Edits from the last ≤30 s (the `quietMs` debounce) are never committed or pushed at quit. The other machine doesn't see them until this machine next launches. Measured: 0 spawns at quit, the file stays ` M`.
- **(b) Store.** `store.commit` schedules the write 150 ms later (`store.ts:291-300`), and `app.exit(0)` kills that timer. Anything committed in the last 150 ms, including `commitBounds` inside `flushAllForQuit` (`windows.ts:436`), is dropped. Example: resize, then ⌘Q, then relaunch: the old bounds come back. Tab switches just before quit are lost the same way.
```diff
--- a/desktop/src/main/index.ts
+++ b/desktop/src/main/index.ts
@@ -241,6 +241,8 @@ app.on('before-quit', (event) => {
   quitting = true
   void manager
     .flushAllForQuit()
+    // Renderers FIRST (their last save lands), then the state file and the last sync commit (YAZ-1111).
+    .then(() => Promise.allSettled([store.flush(), gitSync?.flushForQuit()]))
     .finally(() => app.exit(0))
 })
```
- Risk: quit can now take up to ~5 s longer on a slow network. This is the designed, capped behaviour (`FLUSH_PUSH_TIMEOUT_MS = 5_000`, `sync.ts:70`), and `allSettled` means a failure never blocks exit.
- Proof: extract the chain into a pure `runQuitSequence({ flushRenderers, flushStore, flushSync })` in a testable module and assert order plus exit-on-rejection. Re-run `quitflush.mjs`: expect a `sync: 9-25 Eng Call.excalidraw` commit in the bare remote.

### F3: The `app://` scheme opts out of V8's code cache

- `index.ts:82`: `privileges: { standard: true, secure: true, supportFetchAPI: true }`.
- Custom schemes don't get code caching unless they ask for it. Measured: `~/Library/Application Support/Yaseen Draw/Code Cache/js` = 8 KB (index only). The renderer's JS (several MB, including a 1.36 MB chunk) is compiled cold on every launch.
```diff
-protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
+protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }])
```
- Measured: ~12 ms sooner to dom-ready and ~20–40 ms sooner to canvas. The cache fills to 1.2 MB after 1–2 launches.
- Risk: very low. The cache is keyed by URL and content, and Chromium invalidates it when a new build ships.
- Proof: `ls "Code Cache/js"` grows after two launches, plus a startup A/B.

### F4: `atomicWrite` never fsyncs before the rename

- `fs/fsUtils.ts:165-176`: `writeFile(tmp)` → `rename`, with no fsync. After a kernel panic, power loss or forced reboot, APFS can surface the renamed file with its data blocks never written (zero-length or stale content).
- Every document save goes through this path: boards, diagrams, `.yaseendraw/*.json`, the state file and `secrets.json`.
```diff
--- a/desktop/src/main/fs/fsUtils.ts
+++ b/desktop/src/main/fs/fsUtils.ts
@@ -1,2 +1,2 @@
-import { readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
+import { open, readdir, rename, stat, unlink } from 'node:fs/promises'
@@ -165,9 +165,16 @@
 export async function atomicWrite(file: string, content: string | Uint8Array): Promise<{ mtime: number; size: number }> {
   const tmp = `${file}.tmp-${randomBytes(6).toString('hex')}`
   try {
-    await writeFile(tmp, content, 'utf8')
+    const fh = await open(tmp, 'w')
+    try {
+      await fh.writeFile(content, 'utf8')
+      await fh.sync() // data on disk BEFORE the name points at it (libuv: F_FULLFSYNC on macOS)
+    } finally {
+      await fh.close()
+    }
     await rename(tmp, file)
```
- Cost measured: +5.6 ms per 3.3 MB save and +5 ms per small file.
- The same change is worth making in `landAssets` (`fs/drawing.ts:200`, `wx` writes).
- `secrets.ts:84-86`: pass `mode: 0o600` at open instead of `chmod` after the rename. That closes a window in which the tmp secrets file is world-readable (0644).
- Risk: the only cost is latency. The existing `atomicWrite` tests still pass.

### F5: chokidar costs fds and adds latency

- `fs/watchers.ts:28-34` and `watchedFolder.ts:58`: chokidar 4 uses `fs.watch` per directory **and per file** (no fsevents in v4). Measured 2 335 fds for 2 302 files.
- `awaitWriteFinish {200, 50}` delays every external change by ≥200 ms (259 ms measured) and polls stat every 50 ms per changing file.
- Up to 4 chokidar instances run: the vault, `.yaseendraw`, library media at depth 0, and library components at depth 1 on the same folder.
- The fd limit here is 1 048 576, so this is not a crash risk, but it scales linearly and the idle kernel cost grows with it.
- Node's `fs.watch(root, { recursive: true })` (FSEvents on macOS, ReadDirectoryChangesW on Windows): 0.6 ms setup, 0 extra fds, 14 ms latency, correct coverage of new folders.
- This is an architecture choice, see D1.
- Also: the `electron.vite.config.ts:87` comment "chokidar 4 is pure JS and gets bundled" is **false**. The bundle does `require("chokidar")` (out/main/index.js:9) and works only because electron-builder ships `node_modules/chokidar` + `readdirp` (168 KB) as a `dependency`. Anyone who acts on that comment and moves chokidar to devDependencies breaks startup. Fix the comment, or bundle chokidar for real.

### F6: `drawing:save` does 3 parses and 2 stringifies on the main thread

- `fs/drawing.ts:230`: `sceneElements` parses once.
- `:233` → `shared/drawingAssets.ts:124-141`: `stripEmbeddedFiles` parses again, then stringifies.
- `:242` → `drawingAssets.ts:178-186`: `stampBoardMeta` parses the lean text a third time, then stringifies.
- Measured: 21.4 ms of main-thread block for 3.3 MB vs 8.6 ms with one parse and one stringify (2.5×). Small boards cost 1–2 ms either way.
- Refactor: add object-level cores `stripEmbeddedScene(scene)` and `stampBoardMetaScene(scene, at, prior)` in `shared/drawingAssets.ts`. Keep the string wrappers for `shrink.ts` and the tests. `saveDrawing` parses once, strips and stamps the object, then stringifies once.
- Risk: key order in the output must stay identical (`yaseendraw` first, then the rest). Existing tests plus a byte-equality test against the old path on fixtures prove it. Keep the `lean === json` pass-through only for `shrink.ts`'s "unchanged" check.

### F7: The idle sync poll does a full local stage check every minute

- `git/manager.ts:216-221` arms `poll` → `sync.ts:202-247` runs detect (4 spawns), `keepDroppingsOut` (2), `ensureBoardMergeRule` (1), fetch, rev-list. That is 9 spawns and ~200 ms per pass per synced vault, around the clock.
- A poll only runs when no watcher event has arrived since the last pass. The manager clears `poll` on any event (`manager.ts:322`), so local state is known to be clean.
- Refactor: pass a `poll` mode into `syncPass`. It runs `fetch` + `rev-list`, and only when `behind>0` (or `ahead>0`) does it run the normal full pass. That is 2 spawns instead of 9 (61 ms vs 200 ms measured).
- Also cache `ensureBoardMergeRule` and `ensureVaultIgnores` once per adoption, not once per pass.
- Risk: something that changes the working tree without a watcher event (dot-files, `node_modules`) goes unnoticed until the next edit, focus or wake pass. That is acceptable, because those paths are ignored by design. Test with the manager's fake host (poll mode passes `{poll:true}`) and a sync.test.ts case (behind → full pass).

### F8: Watch-subscribe race leaks a subscription

- `ipc/watch.ts:20-49`: `onSubscribe` awaits `requireDir` before it registers. An `unsubscribe` that arrives in that gap finds nothing (`:53-55`), and the late registration then lives until the window is destroyed. That keeps the chokidar instance for the old root alive and sends it events.
```diff
+const cancelled = new Map<number, Set<string>>() // sender id → ids unsubscribed before their subscribe finished
 async function onSubscribe(e: IpcMainEvent, msg: unknown): Promise<void> {
@@
   if (sender.isDestroyed()) return
+  if (cancelled.get(sender.id)?.delete(id)) return // unsubscribed while requireDir was pending
   let subs = bySender.get(sender.id)
@@
 function onUnsubscribe(e: IpcMainEvent, id: unknown): void {
   if (typeof id !== 'string') return
   const subs = bySender.get(e.sender.id)
   const off = subs?.get(id)
-  if (subs === undefined || off === undefined) return
+  if (subs === undefined || off === undefined) {
+    let set = cancelled.get(e.sender.id)
+    if (set === undefined) cancelled.set(e.sender.id, (set = new Set()))
+    set.add(id)
+    return
+  }
```
- Also clear `cancelled` for the sender in the existing `destroyed` hook.
- Test: subscribe, then unsubscribe before the `requireDir` promise resolves, and assert `activeWatcherRoots()` is empty.

### F9: Small items

- `store.ts:279-300`: every commit writes the file, even when `toDisk` is unchanged (for example `setFolder({expanded})`, which is session-only by design). Keep the last written string and skip the write when it matches. This saves a disk write per folder toggle.
- `windows.ts:432-440`: `flushAllForQuit` flushes windows one at a time, so worst case is N × 5 s. Use `Promise.all` over the windows; the flushes are independent. `commitBounds` stays first.
- `loadDrawing` (`fs/drawing.ts:114-121`) returns the legacy `json` with its embedded base64 **and** the same bytes in `files`. The 20 MB legacy board produced a 40 MB IPC answer. The renderer already replaces `files` with `res.files` (`client/src/drawings/DrawingEditor.tsx:117-122`), so main could return the lean text for legacy boards. Low priority: legacy boards shrink on their first save.
- Security note, not performance: fuses leave `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` **enabled**, and `EnableEmbeddedAsarIntegrityValidation` / `OnlyLoadAppFromAsar` disabled (`npx @electron/fuses read`). Consider flipping them in `afterPack`.
- Secrets pattern: `readOrQuarantine` (`watchedFolder.ts`) treats a valid file with an **older version** as corrupt. The user's `secrets.json.corrupt-1790088458883` is a valid `{version:1}` file quarantined by the v2 bump (a6e6d25). This was probably intended (v1 held Keychain blobs), but future schema bumps should migrate, not quarantine.

---

## 3. Risk and regression proof (summary)

| Change | Feature risk | Proof |
|---|---|---|
| F1 coalescing | None: fresh walk per request is kept | New unit tests, all existing `fs.test.ts`, `stormapp.mjs` A/B |
| F2 quit flush | Quit up to ~5 s slower with pending sync (by design) | Quit-sequence unit test, `quitflush.mjs` shows a commit in the remote |
| F3 codeCache | None | Startup A/B, Code Cache fills |
| F4 fsync | +5 ms per save | Existing `atomicWrite` tests. A power-loss test is manual only |
| F5 watcher swap | Event-semantics edge cases | Watcher conformance suite (below) |
| F6 single parse | Byte-identical output needed | Golden-file equality on fixtures |
| F7 lean poll | Changes invisible to the watcher are picked up at the next edit, focus or wake | manager/sync tests |
| F8 race | None | New unit test |

---

## ARCHITECTURE DECISIONS FOR YASIN

### D1: Vault file watching engine

- **Problem:** chokidar 4 uses one fd per file and dir, gives ≥200 ms change latency, and runs up to 4 instances. It is a runtime dependency that is shipped unbundled.
- **Options:**
  1. Keep chokidar, share one instance across the library stores, and trim `awaitWriteFinish` to 100 ms.
  2. A zero-dependency watcher on `fs.watch(root, {recursive:true})` (FSEvents on Mac, ReadDirectoryChangesW on Windows). Add a thin layer: `lstat` to classify add/change/unlink/addDir/unlinkDir, the same `isSkipped` ignore, a per-path 50–100 ms trailing debounce instead of polling, and an immediate `ready`.
  3. `@parcel/watcher` (native, what VS Code uses). Robust, but it brings back native modules and per-arch builds.
- **Recommendation: 2.**
  - Measured: 0 fds, 0.6 ms setup and 14 ms latency vs 2 335 fds, 141 ms and 259 ms. It removes a dependency, keeps Windows support, and one engine can serve every watcher (vault, config, library).
  - Gate it behind a conformance suite that replays today's chokidar expectations: atomic save → exactly 1 `change`, tmp files silent, mkdir -p + file → `addDir` + `add`, folder rename, trash, and a 200-file burst.
  - Risk to watch: network volumes (SMB) don't emit FSEvents. Keep chokidar polling as the fallback when `fs.watch` throws or the volume is not local.

### D2: Tree answers: full walk per request vs incremental index

- **Problem:** even with F1, every change still re-walks the whole vault once or twice and ships the full tree (660 KB for 2 k files) to every window.
- **Options:**
  1. F1 coalescing + renderer debounce only.
  2. Main keeps a per-root `TreeIndex`, seeded by one walk and patched from the watcher events it already receives (re-read the head only for the changed board). `fs:tree` then returns the cached snapshot in <1 ms.
  3. Option 2 plus delta pushes (`tree:patch`) to renderers instead of snapshots.
- **Recommendation: 1 now (hours of work, removes the pathology), 2 next.**
  - Option 2 makes storms O(events) and gives search and the sweep a free, current index.
  - Option 3 only if 10 k+ file vaults become a target: it moves protocol complexity into the renderer.

### D3: Where "last save before quit" responsibilities live

- **Problem:** the quit ordering (renderers → store → sync) lived in one line of glue in `index.ts`. It was deleted by accident, and no test noticed.
- **Options:**
  1. Restore the line (F2).
  2. Restore it and extract `runQuitSequence` into a tested pure module, with a test that fails if any step is missing.
- **Recommendation: 2.** It is the same size as 1 and makes the regression impossible to repeat.

### D4: Durability vs latency for saves

- **Problem:** no fsync anywhere.
- **Options:**
  1. fsync every `atomicWrite`: +5 ms.
  2. fsync only documents and secrets, not the state file.
  3. Leave as is.
- **Recommendation: 1.** Saves are debounced at 500 ms, so 5 ms is invisible, and board bytes are the product.

---

## EXECUTION ISSUE CANDIDATES (Linear sub-issues)

1. **Coalesce `fs:tree` per root (single-flight + one trailing walk).** `fs/tree.ts`, plus unit tests and a storm benchmark script in `tools/` (F1A).
2. **Debounce the Sidebar's watch-driven refresh (100–150 ms trailing; `ready` stays immediate).** `client/src/sidebar/Sidebar.tsx:538-545` (F1B). Coordinate with the renderer angle.
3. **Restore the quit flush and make it testable** (`runQuitSequence`: renderers → `store.flush` + `gitSync.flushForQuit`, `allSettled`, then exit) (F2/D3).
4. **Enable the V8 code cache on `app://`** (`codeCache: true`) and add a startup A/B script (F3).
5. **Durable `atomicWrite`** (fsync before rename; `landAssets` too; secrets tmp opened with 0600) (F4/D4).
6. **Save path: one parse, one stringify** (object-level `stripEmbedded` / `stampBoardMeta` cores plus golden-byte tests) (F6).
7. **Lean idle sync poll** (fetch + rev-list; escalate to a full pass on behind/ahead; per-adoption caching of attribute and ignore checks) (F7).
8. **Fix the watch-subscribe/unsubscribe race** (`ipc/watch.ts`) (F8).
9. **Watcher engine spike → replace chokidar with a recursive `fs.watch` layer behind a conformance suite; polling fallback for non-local volumes** (F5/D1). Also fix the stale config comment at `electron.vite.config.ts:87`.
10. **Incremental `TreeIndex` in main** (seed walk + event patches; `fs:tree` answers from cache) (D2 option 2).
11. **Small items:** skip identical state-file writes, parallel quit flush across windows, lean `drawing:load` for legacy boards, fuse hardening in `afterPack` (F9).

The research harnesses (startup, tree storm, idle CPU, quit flush, fs.watch bench) were one-off scripts; their checked-in successors are under `tools/perf/`.
