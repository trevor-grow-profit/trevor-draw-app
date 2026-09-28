# Vendored drawing engine (yaseendraw)

The five `yaseendraw-*-<forkCommit>.tgz` tarballs are `@excalidraw/excalidraw` and its four
monorepo siblings (`common`, `element`, `math`, `fractional-indexing`), built from Yasin's
fork (github.com/yaseenarshad/yaseen-excalidraw) at the commit named in every filename.
Yaseen Draw consumes them through the `file:` dependencies in `client/package.json`
(YAZ-868 rulings D1/D2, carried into YAZ-1775: consume the fork build as-is, pinned
tarballs in-repo, no patching on our side).

The fork hash in the filename is load-bearing twice over: it pins provenance, and it busts
npm's `file:` tarball cache so a bump is actually picked up.

**Why five and not one.** The fork's package build externalizes its siblings as real runtime
imports, and those siblings don't exist on npm at the fork's versions — so they ship
alongside. They're tiny; the main tarball's ~31 MB is mostly fonts plus the dev build that
the package's `exports` map requires. Two other `@excalidraw` packages are *not* vendored:
`@excalidraw/laser-pointer` (1.3.1) and `@excalidraw/utils` are untouched by the fork and
resolve from the registry normally. Don't pack them.

## Bumping to a new fork commit

Check the fork out at the commit you want, leave it clean, then from the repo root:

```bash
node tools/packEngine.mjs --commit <sha>
npm ci
```

`tools/packEngine.mjs [--fork <path>] [--commit <sha>] [--use <dir>]` does the whole thing:
verifies the fork is clean and on the commit, `yarn install`s it, runs `build:esm` and
`npm pack` per package, renames each tarball with the short hash, deletes the previous set,
repoints the five `file:` entries in `client/package.json`, rewrites every matching
`resolved`/`integrity` in `package-lock.json`, restores the fork's `yarn.lock`, and refuses
to finish if any reference to an older fork hash survives. `--use` copies an already-built
set instead of rebuilding, accepting only tarballs whose filenames carry the commit.

Its pure parts live in `tools/lib/packEngine.mjs` with tests in `tools/packEngine.test.mjs`.

Afterwards, confirm the engine you think you installed is the one you got:

```bash
grep -c writingMode "$(npm ls @excalidraw/excalidraw -w client --parseable | tail -1)/dist/prod/index.js"
```

Greater than 0 means Writing mode is in the build. The same check with `laserTrailMode` in place of
`writingMode` confirms the laser's modes (YAZ-1989) are in it. Note the `npm ls` detour — npm hoists the
engine to the workspace root, so it lands in `./node_modules/@excalidraw/excalidraw`, not
under `client/`.

## The two traps

**1. npm keys `file:` deps on content, not on the filename.** If a package builds
byte-identically across two fork commits — `fractional-indexing` does exactly this —
`npm install` sees no content change and leaves its old `resolved: file:…-<oldhash>.tgz` in
`package-lock.json`, even though `client/package.json` has moved on and the bump deleted
that tarball. `npm install` papers over it; a clean `npm ci` dies. So `packEngine` rewrites
every `resolved` for the five explicitly (in `packages[…]` entries and in any legacy
`dependencies` block), recomputes `integrity` as the sha512 of the new tarball bytes, and
then greps both files for any surviving old hash and fails the run if it finds one.

This is not theoretical: the `9e63bdf2` tarballs predated Writing mode, and the Writing
toggle silently did nothing until the bump to `e72242f8`. Hence the presence check above.

**2. `yarn install` in the fork dirties `yarn.lock`.** It re-dedupes (`strip-ansi`) and
rewrites the file. The script restores it with `git checkout -- yarn.lock` and asserts the
fork's working tree is clean afterwards, because a dirty fork means the build no longer
corresponds to the commit stamped into the filenames. Nothing else in the fork is ever
touched — `yarn install`, `build:esm`, `npm pack`, and that's the lot.

One more operational note: `npm ci` wipes `node_modules` out from under a running dev
server. Stop it first. (`npm install` tolerates it; `npm ci` does not.)
