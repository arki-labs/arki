# Ship an update to an existing `@arki/*` wave package

Most common release operation. A package that's already published gets a new version.

## Decision matrix

| Situation | Path |
|---|---|
| Normal change (any kind, on the 0.0.x track) | **A — Changesets-driven patch bump** |
| You need a non-monotonic version (downgrade, custom semver) | **B — Manual edit** |
| Multiple packages changed together; cascade desired | **A — Changesets with multi-package entry** |

## Path A — Changesets-driven bump

```bash
# 1. Write the changeset entry (interactive prompt for affected packages + bump type)
bunx -p @changesets/cli changeset
# Or write it manually at .changeset/<slug>.md:
#   ---
#   '@arki/<name>': patch    # always patch on 0.0.x experimental track
#   ---
#   Short description of what changed and why.

# 2. Apply the changeset — bumps source manifests + consumes the entry
bunx -p @changesets/cli changeset version

# 3. Verify the bump landed where you expected
git diff --stat packages/

# 4. Re-materialize the public tree (concrete versions, no workspace:*)
bun tooling/arki-release/src/cli.ts export-public

# 5. Run the scorecard — must report `Stable release gate: OPEN`
bun tooling/arki-release/src/cli.ts scorecard | tail -20

# 6. Commit the source bumps (scope precisely; sibling agents may have staged work)
git -c commit.gpgsign=false commit \
  packages/<pkg>/package.json \
  apps/*/package.json packages/*/package.json \
  -m "release: <description>"

# 7. Publish to npm — user must run this (OTP gate)
for p in <changed-packages>; do
  echo "=== Publishing @arki/$p ==="
  (cd .release/arki-public/packages/$p && npm publish --access public)
done

# 8. Verify on npm
npm view @arki/<pkg> version

# 9. Sync the GitHub mirror (see sync-github.md)
```

## Path B — Manual version edit

Use when changesets can't express what you need (e.g., downgrade 0.1.0 → 0.0.1, custom prerelease).

```bash
# 1. Edit each affected package.json with sed — preserves UTF-8, no JSON re-serialization drift
sed -i '' 's/"version": "<old>"/"version": "<new>"/' packages/<pkg>/package.json

# 2. Verify
git diff packages/<pkg>/package.json

# 3. Re-materialize, scorecard, publish, sync as in Path A steps 4–9
```

**Important:** never use `python -m json.dump` for version edits. It escapes UTF-8 (em-dashes → `—`), creating spurious diffs. `sed` is the right tool — it touches one byte sequence and leaves the rest alone.

## Watch points

- **Cascade reach** — `updateInternalDependencies: "patch"` in `.changeset/config.json` means a Wave 1 bump auto-patch-bumps every consumer (apps, Wave 2-5 packages). That's ~80 file changes for a single Wave 1 patch. Expected and benign — all consumers are mostly private packages whose version doesn't affect npm.
- **Peer-dep coupling** — `@arki/env` peer-depends on `@arki/dot`. When `@arki/dot` ships a new major, `@arki/env`'s peer constraint may need a manual bump in source. Check after every Wave 2 release.
- **Scorecard re-run is mandatory** — bumping source touches the materialized tree's manifests; the scorecard catches surprises (regenerated `files` array, new leaks from updated docs, etc.).
- **Source != tree != npm** — the source has `workspace:*`, the tree has `0.0.1`, npm has the tarball. All three must converge before "shipped" is true.

## What npm publish actually packs

Each `<pkg>/package.json#files` array controls the npm tarball. Currently most packages have `files: ["dist"]` — meaning **the npm tarball does NOT include `src/`**, even though `src/` is in `.release/arki-public/` and on GitHub. This is intentional separation:

- **npm consumers** get compiled `dist/*.js` + `dist/*.d.ts` (smaller install).
- **GitHub visitors** get `src/*.ts` (readable source).

To opt source into npm too, add `"src"` to a package's `files` array. Worth doing for 0.0.x experimental packages — improves debuggability. Tradeoff: ~3-5× tarball size for source-heavy packages.

## Verification checklist before declaring "shipped"

- [ ] `bun release:arki scorecard` → `Stable release gate: OPEN`
- [ ] `npm view @arki/<pkg> version` → returns the new version
- [ ] `git log --oneline -1 .release/arki-public/.git/` (in the mirror) → new commit pushed
- [ ] `git ls-remote git@github.com:arki-labs/arki.git refs/tags/<tag>` → tag exists on remote
- [ ] Source monorepo commit pushed (Coolify, internal CI, etc. may consume it)
