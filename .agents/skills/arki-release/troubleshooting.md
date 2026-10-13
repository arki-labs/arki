# arki-release troubleshooting — pitfalls discovered the hard way

Battle-tested traps from real release sessions. Each one cost time; documented here so you don't pay again.

## The npm OTP wall

**Symptom:** `npm publish` fails with `npm error code EOTP — This operation requires a one-time password from your authenticator.`

**Root cause:** npm's default 2FA mode (`Authorization and publishing`) requires a fresh OTP for every write operation. The OTP must come from a human-controlled device (authenticator app, hardware key). An agent CANNOT generate it.

**Three solutions, ordered by appropriateness:**

1. **Manual loop in user's terminal** (best for one-shot publications):
   ```bash
   for p in <pkg-list>; do
     echo "=== Publishing @arki/$p ==="
     (cd .release/arki-public/packages/$p && npm publish --access public)
   done
   ```
   User runs this; npm prompts for OTP each time. ~30 seconds per OTP, ~5 minutes for 10 packages.

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

**Agent contract:** when you hit EOTP, **stop and surface the manual-loop command**. Don't try to retry, don't ask for OTP-pass-through (each OTP is single-use ~30s, impractical for 10 packages).

## The `git add -A` parent-walk trap

**Symptom:** Running `git add -A` inside `.release/arki-public/` (or any folder without its own `.git/`) stages files from the parent monorepo (`apps/<x>/`, `tooling/<y>/`, `.claude/`). `git status` shows paths like `../../apps/avocabo/...`.

**Root cause:** the export folder never has a `.git/` (`export-public`'s `removeDirectory(outputPath)` wipes it); mirror git work belongs in `.release/arki-mirror/`. Git walks UP looking for a `.git/`, finds the monorepo's, and operates against THAT.

**Detect before damaging:**
```bash
cd /Users/afurculita/Developer/workspace/.release/arki-mirror
git rev-parse --git-dir
# MUST be:  /Users/afurculita/Developer/workspace/.release/arki-mirror/.git
# If it's the monorepo's path, STOP: clone the mirror there first (sync-github.md step 3).
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

**Fix (since 2026-10-13):** never keep git state in the export folder. The mirror checkout lives in `.release/arki-mirror/` and receives the export via `rsync --delete --exclude .git`; see [sync-github.md](./sync-github.md).

## Chicken-and-egg: transitive `@arki/*` deps in pre-publication state

**Symptom:** Fixture matrix (`bun release:arki fixture --full`) fails with `FIX_E004 install failed (exit 1)` for Wave 2/3 packages even though they pack cleanly.

**Root cause:** Wave 2/3 packages have `dependencies` like `"@arki/contracts": "0.0.1"`. When the fixture installs the tarball, npm tries to resolve `@arki/contracts@0.0.1` from the npm registry — but if that version was never published, install fails.

**Two solutions:**

1. **Ship in waves** — publish Wave 1 to npm first, then Wave 2 (its `@arki/*` deps now exist on npm), then Wave 3. Natural ordering that dissolves the cycle.
2. **Satellite tarball cache** — future fixture-matrix improvement. The matrix would stage all packed tarballs in a temp dir and tell the PM (via `overrides` or `--registry file://`) to resolve `@arki/*` from there. ~4-8 hours of tooling work, not done yet.

For now, accept that pre-publication Wave 2/3 packages can't be fixture-verified. The scorecard's `dot-gates` (kernel boot probe) is the next-best verifier.

## Fixture matrix probes assume a root `.` export

**Symptom:** `FIX_E005 ESM import probe failed` for packages like `@arki/assert`, `@arki/date` — even though the packages are pack-clean.

**Root cause:** The matrix's probe hardcodes `import * as pkg from "@arki/<name>"` (root specifier). Packages with subpath-only exports (`@arki/assert/base64`, `@arki/assert/language`, `@arki/assert/url` — no `.` entry) fail to resolve.

**Workaround:** acknowledge as known matrix limitation, don't treat as a publication blocker for subpath-only packages. The package's own tests cover the import paths properly.

**Real fix (future work, ~1-2 hours):** make the matrix inspect each package's exports map and template a real subpath into the probe instead of the bare specifier.

## "Stable release gate: BLOCKED" but I can't tell why

**Symptom:** Scorecard says BLOCKED; gate decision shows multiple packages with multiple blockers.

**Diagnostic incantation:**
```bash
# Get a machine-readable blocker breakdown
bun tooling/arki-release/src/cli.ts scorecard --json 2>/dev/null | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for it in data.get('items', []):
    if it.get('overall') != 'pass':
        print(f\"{it['name']} [{it['overall']}]\")
        for dim, d in it.get('dimensions', {}).items():
            if d.get('status') not in ('pass',):
                print(f\"  {dim}: {d['status']} — {d.get('details', '')}\")
"
```

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

**Rule (founder, 2026-10-13):** the mirror keeps one commit per release on top of the last. Syncs use a plain `git push`. Before that date every sync was `git init` + `git push --force`, which reset `main` to a single commit and broke every clone's `git pull`.

**If a plain push is rejected:** `origin/main` moved since your fetch. Inspect `git log --oneline main..origin/main` in `.release/arki-mirror/`; if you don't recognize it, STOP and surface it to the user. Otherwise redo the fetch → rsync → commit steps in [sync-github.md](./sync-github.md). Do not force.

## Per-package mirror description-stamp failures

**Symptom 1:** `sync-package-repos` emits a `SYNC_E001 gh repo edit (description) failed` warning.

**Cause:** The `gh` CLI token lacks repo-edit permission, or GitHub rejected the description (e.g. exceeded 350-char limit — the tool already truncates, but custom org policies can be stricter).

**Fix:** Re-auth with `gh auth login -s repo` (broad scope). Confirm with `gh auth status -h github.com` showing `Token scopes:` containing `repo`. Re-run the sync; the description stamp will succeed.

---

**Symptom 2:** The mirror's description does NOT start with `[Read-only mirror]` even after a successful sync.

**Cause:** Either (a) the npm `description` field is empty and you're looking at the default GitHub auto-description, or (b) the `gh repo edit` warning was suppressed in non-`--json` mode.

**Fix:** Run `bun release:arki sync-package-repos --json --package "@arki/<name>" | jq '.errors'` to surface any warnings. If empty, verify with `gh api repos/arki-labs/<name> --jq '.description'`. If still wrong, `gh repo edit arki-labs/<name> --description "[Read-only mirror] <desc>"` manually.

---

**Symptom 3:** `sync-package-repos` reports `failed` mid-batch and the workspace temp dir is full of `arki-mirror-*` directories.

**Cause:** A `failed` exit from `syncOnePackage` returns before the `await rm(workDir, ...)` cleanup. The orchestrator continues to the next package, but the failed package's temp dir leaks.

**Fix:** `\rm -rf /tmp/arki-mirror-*` (escape `rm` to bypass the workspace `-i` alias). Re-run the sync with `--package "@arki/<failed-name>"` to retry just that one.

---

**Note on the previous archive doctrine (decommissioned 2026-05-21):** earlier versions of `sync-package-repos` archived each mirror at the end of every run. The unarchive→push→re-archive dance was operationally expensive (3 gh calls per sync per package) and added a failure mode where a mid-sync error could leave the mirror unarchived for days. The current doctrine drops archiving entirely; the read-only signal is the `[Read-only mirror]` description prefix plus disabled Issues/Wiki. If you find an old mirror that's still archived, run `gh api repos/arki-labs/<name> -X PATCH -F archived=false` once (or just re-run the sync — it auto-unarchives any archived mirror it touches).

## Per-package mirror tag-drift after a yank

**Symptom:** You yank a published version from npm, then `bun release:arki history` reports the mirror as `tag-drift` with extra tags that aren't on npm.

**Cause:** Tags are sticky — the mirror was synced before the yank, so it carries a `v<yanked-version>` tag that npm no longer has. The classifier compares published-versions ⊆ mirror-tags, but the inverse leak (mirror has versions npm doesn't) only shows up as a *warning* not a failure.

**Fix:** `bun release:arki sync-package-repos --package "@arki/<name>" --force` — the force-rebuild deletes the local tag set and rebuilds from npm's current published list, so the yanked tag disappears on the next `git push --force --tags`.

**Note:** GitHub keeps abandoned tags in dangling-tag GC for ~30-90 days; if you yanked by mistake, the tag is recoverable via reflog during that window.

## Bulk-sync rate-limited by GitHub API

**Symptom:** Mid-batch, `sync-package-repos` starts failing with `SYNC_E001 gh api ...` mentioning `secondary rate limit` or `403`.

**Cause:** The sync makes 2-5 `gh api` calls per package (probe + unarchive + archive + repo create + repo edit). For 14 packages this is ~30-50 calls. GitHub's secondary rate limits kick in around 30 mutating requests / minute.

**Fix:** Wait 60 seconds, then re-run with `--package` flags for just the packages that didn't finish (look at the `failed` items in the envelope). The sync is fully resumable — successful packages skip on the next run because they're now `in-sync`.

**Prevention:** For the first bulk-create of all 14 packages, expect this and plan two passes 60 seconds apart. Subsequent incremental syncs (one new version on one package) won't hit the limit.

## External install fails on a dependency the package never declared

**Symptom (2026-10-09, `@arki/ui` 0.1.3):** a clean clone of an external consumer
installs from npm, then `vite build` dies with
`Rolldown failed to resolve import "class-variance-authority" from node_modules/@arki/ui/src/button.tsx`.
Inside the monorepo the import works because the hoisted `node_modules` happens
to contain the package through some other workspace.

**Why the scorecard let it through:** the `dependencies` dimension checks that
*declared* deps resolve (no private `@arki/*`, no unresolved `catalog:`). It does
not compare the imports in `src/` against the manifest.

**Fix:** declare the dependency (same `catalog:` spec the siblings use), changeset,
republish. **Before promoting a package, run the undeclared-import scan** (compare
every bare specifier in `src/**/*.{ts,tsx,css}` with `dependencies` +
`peerDependencies`; `~icons/*` and doc-comment imports are false positives).
Candidate for a scorecard dimension (`imports`); not implemented yet.

**The real gate is a clean clone outside the workspace** installing from the
registry: it is the only check that cannot see the monorepo's `node_modules`.
