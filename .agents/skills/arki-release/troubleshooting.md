# arki-release troubleshooting — pitfalls discovered the hard way

Battle-tested traps from real release sessions. Each one cost time; documented here so you don't pay again.

## Error codes from `ship`

| Code | Meaning | Do this |
|---|---|---|
| SHIP_E001 | Versions bumped and built (a stop, not a failure) | Review the diff, run the printed commit line, then `ship --wave <id> --resume` |
| SHIP_E002 | A changeset bumps a package outside the wave, or `changeset version` bumped one in another wave or in no wave (a same-wave dependent bump is fine) | Split the changeset; restore any stray `package.json` / `CHANGELOG.md` |
| SHIP_E003 | `changeset version`, the build or `node_modules/.bin/changeset` failed or is missing | Fix the step; `@changesets/cli` must be a workspace dev dependency (never `bunx`) |
| SHIP_E004 | `--finish` run by an agent or without a TTY | The founder runs it in a terminal |
| SHIP_E005 | npm has the version with a different `dist.integrity` | Do not republish. Find what was published; ship a new patch from a fresh candidate |
| SHIP_E006 | The version is not on npm yet | Run its publish line from `packet.md`, then rerun `--finish` |
| SHIP_E007 | A candidate check failed; no packet | `bun release:arki scorecard --candidate <dir>` and fix each blocker |
| SHIP_E008 | Bad flags, unknown wave, nothing to release | Fix the command or add a changeset |
| SHIP_E009 | Mirror sync failed or is not wired | Fix, then rerun `--finish` (npm, `shipped` and the ledger are already done) |
| SHIP_E010 | `npm view` failed (network, auth) | Check `npm whoami` and the network, rerun |

## The npm OTP wall

**Symptom:** `npm publish` fails with `npm error code EOTP — This operation requires a one-time password from your authenticator.`

**Root cause:** npm's default 2FA mode (`Authorization and publishing`) requires a fresh OTP for every write operation. The OTP must come from a human-controlled device (authenticator app, hardware key). An agent CANNOT generate it.

**Three solutions, ordered by appropriateness:**

1. **The packet, in the founder's terminal** (best for one-shot publications): run the `npm publish --access public <abs tarball>` lines of `.release/candidates/<dir>/packet.md` from `/tmp`. npm prompts for an OTP each time. ~30 seconds per OTP, ~5 minutes for 10 packages.

2. **Automation token** (best for repeat ships):
   ```bash
   npm token create --automation
   # Paste the token into ~/.npmrc:
   echo "//registry.npmjs.org/:_authToken=npm_xxxx" >> ~/.npmrc
   # Now `npm publish` works without OTP.
   # When done, revoke: npm token revoke <token-prefix>
   ```
   Tokens persist — revoke after the ship to limit blast radius.

3. **Lower 2FA mode** (last resort):
   `npmjs.com → Account Settings → Two-Factor Authentication → "Authorization only"`. Permanently weakens write security. Avoid.

**Agent contract:** agents never publish. Point the founder at `packet.md`. Don't try to retry, don't ask for OTP-pass-through (each OTP is single-use ~30s, impractical for 10 packages).

## The `git add -A` parent-walk trap

**Symptom:** Running `git add -A` inside `.release/arki-public/` (or any folder without its own `.git/`) stages files from the parent monorepo (`apps/<x>/`, `tooling/<y>/`, `.claude/`). `git status` shows paths like `../../apps/avocabo/...`.

**Root cause:** the export folder never has a `.git/` (`export-public`'s `removeDirectory(outputPath)` wipes it). Never do git work there. Git walks UP looking for a `.git/`, finds this repo's, and operates against THAT. Package mirror git work belongs in `.release/package-mirrors/<name>/`, which `sync --prepare` creates with its own `.git/`.

**Detect before damaging:**
```bash
cd .release/package-mirrors/<name>
git rev-parse --git-dir
# MUST be:  .git (this folder's own)
# If it's this repo's path, STOP: delete the folder and run `sync --prepare` (it creates the checkout).
```

**Recover after damaging:** the index pollution is reversible via `git reset HEAD <path>`, but the workspace's "only-touch-own-edits" rule forbids `reset` on sibling-agent files. So:

- Don't reset their work.
- Commit ONLY your own paths with `git -c commit.gpgsign=false commit <my-paths> -m "..."`.
- Sibling agents will re-stage their work as they need.

## `npm publish` parent-walks into the workspaces root

**Symptom:** Running `cd .release/arki-public/packages/<pkg> && npm publish --access public` fails with `'@arki/<pkg>@*' is not in this registry.` or hangs on a workspaces-mode resolution that produces nonsense `@arki/X@*` specs.

**Root cause:** the materializer writes a `package.json` at `.release/arki-public/` with `"workspaces": ["packages/*"]` (it's there for the fixture matrix's install probes to have a workspace context). When `npm publish` runs from a child directory, npm parent-walks looking for the nearest `package.json`, finds the workspaces root, and switches to **workspace mode** — which mangles standalone publishes by trying to resolve every workspace-internal `@arki/X` ref as `@arki/X@*` (the wildcard "any workspace version" placeholder npm uses internally).

**Detect before publishing:** verify what npm thinks the cwd is by running `npm config get registry` from inside the package dir. If you see `ENOWORKSPACES — This command does not support workspaces.`, npm IS in workspace mode and publish will fail.

**Workaround — the path-form `npm publish <dir>`:** instead of `cd`-ing, pass the package directory as an absolute path argument and run from somewhere *outside* the workspace tree:

```bash
# From your home dir or /tmp — anywhere outside /Users/.../workspace
npm publish --access public /Users/afurculita/Developer/workspace/.release/arki-public/packages/dot
```

This bypasses the parent-walk entirely. npm reads the named directory's `package.json` directly without searching up. **Use this form in every ship loop:**

```bash
for p in <pkg-list>; do
  echo "=== Publishing @arki/$p ==="
  npm publish --access public "/Users/afurculita/Developer/workspace/.release/arki-public/packages/$p"
done
```

**Verification after publish** (also from outside the workspace, to avoid the same parent-walk on `npm view`):

```bash
cd ~
for p in <pkg-list>; do
  printf "%-25s %s\n" "@arki/$p" "$(npm view @arki/$p version 2>&1 | tail -1)"
done
```

**Built-in fix (added 2026-05-21):** `bun release:arki export-public --no-workspaces-root` materializes the tree WITHOUT a workspaces field at the root. The publish loop can then use the standard `cd packages/<pkg> && npm publish` form because npm's parent-walk finds a non-workspaces root and behaves normally. The default behavior (no flag) keeps the workspaces field for `arki-labs/arki` cloners who want `bun install` to resolve the tree.

**Canonical ship sequence** with the flag:

```bash
# Publish-mode materialization (no workspaces field)
bun release:arki export-public --no-workspaces-root

# Publish loop (either form works once the root has no workspaces)
for p in <pkg-list>; do
  npm publish --access public ".release/arki-public/packages/$p"
done

# Before syncing arki-labs/arki, re-materialize with the workspaces
# field so cloners can `bun install` cleanly
bun release:arki export-public
```

The path-form workaround (`npm publish <abs-path>` from outside the workspace) still works as a fallback if you forget the flag.

## The npm 2FA browser-auth "did it succeed?" pattern

**Symptom:** `npm publish` prints `Authenticate your account at: https://www.npmjs.com/auth/cli/<token> — Press ENTER to open in the browser...`, you authenticate, then **after a delay** the terminal prints `npm error code E403 — You cannot publish over the previously published versions: <ver>`.

**Root cause:** npm's modern 2FA flow (rolled out 2024+) publishes the tarball **as soon as the browser auth completes**, often before the terminal session displays the result. If you retry — by hitting up-arrow or re-running the loop because the terminal looked unresponsive — npm rejects the second PUT against the now-published version. The 403 is a real error response, but the publish *already succeeded* on the first try.

**Verify success before retrying:**

```bash
cd ~
npm view @arki/<pkg> version
# If this prints your expected version, the publish landed. Move on.
# Only retry if it prints a DIFFERENT version or 404s.
```

**Operational habit:** in a multi-package ship loop, the 403 inside the loop is benign — keep going. Verify ALL packages at the end with the bulk `npm view` check. Do NOT abort the loop on a single 403.

## The `.git/` preservation gotcha during re-materialize

**Symptom:** a `.git/` inside `.release/arki-public/` disappears after `export-public`, or a git command there acts on the monorepo.

**Root cause:** `export-public` calls `removeDirectory(outputPath)`, which wipes `.release/arki-public/` entirely, `.git/` included. Moving `.git/` out and back is fragile (a `mv` into an existing dir nests it).

**Fix (since 2026-10-13):** never keep git state in the export folder. Since 2026-10-30 there is no `arki-labs/arki` mirror checkout at all: this repo is the source, and a release only tags it. The package mirror checkouts live in `.release/package-mirrors/` and are rebuilt by `sync --prepare`; see [sync.md](./sync.md).

## Chicken-and-egg: transitive `@arki/*` deps in pre-publication state

**Symptom:** Fixture matrix (`bun release:arki fixture --full`) fails with `FIX_E004 install failed (exit 1)` for Wave 2/3 packages even though they pack cleanly.

**Root cause:** Wave 2/3 packages have `dependencies` like `"@arki/contracts": "0.0.1"`. When the fixture installs the tarball, npm tries to resolve `@arki/contracts@0.0.1` from the npm registry — but if that version was never published, install fails.

**Two solutions:**

1. **Ship in waves** — publish Wave 1 to npm first, then Wave 2 (its `@arki/*` deps now exist on npm), then Wave 3. Natural ordering that dissolves the cycle.
2. **Satellite tarball cache** — future fixture-matrix improvement. The matrix would stage all packed tarballs in a temp dir and tell the PM (via `overrides` or `--registry file://`) to resolve `@arki/*` from there. ~4-8 hours of tooling work, not done yet.

`ship --resume` covers this: `smoke --candidate` installs all candidate tarballs together in a clean consumer, so unpublished `@arki/*` deps resolve from the candidate.

## Fixture matrix probes assume a root `.` export

**Symptom:** `FIX_E005 ESM import probe failed` for packages like `@arki/assert`, `@arki/date` — even though the packages are pack-clean.

**Root cause:** The matrix's probe hardcodes `import * as pkg from "@arki/<name>"` (root specifier). Packages with subpath-only exports (`@arki/assert/base64`, `@arki/assert/language`, `@arki/assert/url` — no `.` entry) fail to resolve.

**Workaround:** acknowledge as known matrix limitation, don't treat as a publication blocker for subpath-only packages. The package's own tests cover the import paths properly.

**Real fix (future work, ~1-2 hours):** make the matrix inspect each package's exports map and template a real subpath into the probe instead of the bare specifier.

## An entry loads only inside a bundler or a worker

**Symptom:** `smoke` fails with `SMOKE_E002` on an entry that renders `@arki/ui` source (`@arki/auth/react`) or needs a service worker (`@arki/tanstack-start/pwa/sw`). Plain Node and Bun cannot load it.

**Fix:** list the export key in the package's `package.json`, next to `runtimes`:

```json
"arki": { "bundlerOnly": ["./react", "./react/templates"] }
```

`consumer-smoke.mjs` then prints `SKIP <runtime> <spec> (bundler-only entry; checked by the Vite build)`. `smoke` runs its Vite build for that wave, even a compiled one, and the build imports those entries. The `vite-build` check says how many subpaths it bundled.

List only entries that truly need a bundler. Every other entry must still import in Node and Bun. Each key must be in `exports`, spelled the same (`./react`, not `react`). A key that is not there fails with `SMOKE_E010`.

## "Stable release gate: BLOCKED" but I can't tell why

**Symptom:** Scorecard says BLOCKED; gate decision shows multiple packages with multiple blockers.

**Diagnostic:** `bun release:arki scorecard --candidate <dir>` prints each failing dimension with its details; `--table` adds the readiness table (`FAIL` blocks, `warn` does not).

Most common blockers:

| Dimension | Blocker meaning | Fix |
|---|---|---|
| `dot-gates: fail` | DOT probe couldn't boot 3 adapters OR contract arrays missing | Inspect `tooling/arki-release/src/dot-probe-runner.ts` output; verify `@arki/dot` + adapters are buildable |
| `dot-gates: deferred` | Probe skipped (`--skip-dot-probe`) | Re-run scorecard without that flag |
| `agent-native-gates: fail` | `dot new --dry-run --json` envelope invalid | Check `packages/dot/src/cli/new.ts` and the scaffold template |
| `build-output: fail` | Package missing `dist/*.js` or `dist/*.d.ts` | `turbo build --filter=@arki/<name>` |
| `privacy: fail` | Leak scanner caught an error-severity hit | Check `tooling/arki-release/src/leaks.ts` patterns; remove the offending text |
| `packlist: fail` | npm pack would include forbidden files (tests, .env, raw source) | Audit the package's `files` array |
| `docs: fail` | README or LICENSE missing | Add them |

## Python `json.dump` corrupts UTF-8

**Symptom:** Bumping a version via Python script produces a diff that re-encodes em-dashes (`—` → `—`) and other Unicode in unrelated description fields.

**Root cause:** Python's `json.dump` defaults to `ensure_ascii=True`, escaping every non-ASCII char.

**Fix:** Use `sed` for single-field edits:
```bash
sed -i '' 's/"version": "<old>"/"version": "<new>"/' packages/<name>/package.json
```

Or pass `ensure_ascii=False` if you really need Python:
```python
json.dump(d, open(path, 'w'), indent=2, ensure_ascii=False)
```

## Never force-push `arki-labs/arki`

**Rule (founder, 2026-10-13):** never force-push. Before that date every sync was `git init` + `git push --force`, which reset `main` to a single commit and broke every clone's `git pull`.

**Since 2026-10-30:** this repo is `arki-labs/arki`, the real source. `sync` never commits here and never pushes `main`. It only pushes the wave tag. Push source changes yourself with a plain `git push`. If that push is rejected, `git fetch` and read `git log --oneline main..origin/main`; if you don't recognize it, STOP and surface it to the user. Do not force.

**Package mirrors:** if `sync --apply` reports a rejected push (`MSYNC_E011`) for `arki-labs/<name>`, inspect `git log --oneline main..origin/main` in `.release/package-mirrors/<name>/`. If you don't recognize it, STOP. Otherwise run `sync --prepare` again, then `sync --apply` ([sync.md](./sync.md)).

## Per-package mirror repo or Release creation fails

**Symptom:** `sync --apply` fails with `MSYNC_E010` (a `gh` command failed).

**Cause:** The `gh` token lacks permission to create repos or Releases in `arki-labs`, or GitHub rate-limited the run.

**Fix:** Re-auth with `gh auth login -s repo`, check `gh auth status -h github.com`, wait a minute if it was a rate limit, then run `sync --apply` again. It skips every tag and Release that already exists, so a rerun only does what is left.

**Symptom:** `sync --prepare` fails with `MSYNC_E006` (dirty package mirror) or `MSYNC_E007` (not its own checkout).

**Fix:** See [sync.md](./sync.md). Delete the directory it names and prepare again; the checkouts under `.release/` are disposable.

---

## Per-package mirror tag-drift after a yank

**Symptom:** You yank a published version from npm, then `bun release:arki history` reports the mirror as `tag-drift` with extra tags that aren't on npm.

**Cause:** Tags are sticky — the mirror was synced before the yank, so it carries a `v<yanked-version>` tag that npm no longer has. The classifier compares published-versions ⊆ mirror-tags, but the inverse leak (mirror has versions npm doesn't) only shows up as a *warning* not a failure.

**Fix:** Published tags never move and `sync` never force-pushes. A yanked version's tag stays on the mirror. If it must go, the founder deletes it by hand (`git push origin :v<version>` in the mirror, plus `gh release delete`), with explicit approval.

**Note:** GitHub keeps abandoned tags in dangling-tag GC for ~30-90 days; if you yanked by mistake, the tag is recoverable via reflog during that window.
