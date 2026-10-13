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
#    Use --no-workspaces-root for the publish-mode tree (npm publish from
#    a child dir would otherwise parent-walk into the workspaces field and
#    break). Re-run WITHOUT the flag before the GitHub mirror sync,
#    so cloners of arki-labs/arki can still `bun install` from the root.
bun tooling/arki-release/src/cli.ts export-public --no-workspaces-root
#    It exports HEAD. Commit the bump and build first: a package with
#    uncommitted non-Markdown changes is exported WITHOUT dist/ and listed as
#    an EXPORT_E006 warning — never publish a package that has that warning.

# 5. Run the scorecard — must report `Stable release gate: OPEN`
bun tooling/arki-release/src/cli.ts scorecard | tail -20

# 6. Commit the source bumps (scope precisely; sibling agents may have staged work)
git -c commit.gpgsign=false commit \
  packages/<pkg>/package.json \
  apps/*/package.json packages/*/package.json \
  -m "release: <description>"

# 7. Publish to npm — user must run this (OTP gate)
# CRITICAL: use the path-form, NOT `cd && npm publish`. The materializer's
# workspaces root at .release/arki-public/package.json poisons npm publish
# when it parent-walks from a child directory (see troubleshooting.md →
# "npm publish parent-walks into the workspaces root").
for p in <changed-packages>; do
  echo "=== Publishing @arki/$p ==="
  npm publish --access public "/Users/afurculita/Developer/workspace/.release/arki-public/packages/$p"
done

# 8. Verify on npm — also from OUTSIDE the workspace (same parent-walk trap)
cd ~
for p in <changed-packages>; do
  printf "%-25s %s\n" "@arki/$p" "$(npm view @arki/$p version 2>&1 | tail -1)"
done

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

- **Cascade reach** — `updateInternalDependencies: "patch"` auto-patch-bumps wave-package consumers, but since 2026-07-04 the cascade stops at the wave boundary: `"privatePackages": { "version": false, "tag": false }` plus `private: true` on every app and non-wave package means `changeset version` touches ONLY wave packages. If an `apps/**` or non-wave manifest shows a bump, a `private: true` flag is missing somewhere — fix the flag and revert the bump (see SKILL.md hard rules). Before this fix a single Wave 1 patch dirtied ~130 app files that had to be hand-reverted every release.
- **Peer-dep coupling** — `@arki/env` peer-depends on `@arki/dot`. When `@arki/dot` ships a new major, `@arki/env`'s peer constraint may need a manual bump in source. Check after every Wave 2 release.
- **Peer-dependent MAJOR-bump trap** (hit 2026-07-07, dot 0.2.0→0.3.0) — when a peerDependency gets a **minor or major** bump, `changeset version` major-bumps every peer-dependent. All four adapters + `@arki/http` landed on the founder-reserved `1.0.0` and had to be corrected via Path B sed (versions AND `## 1.0.0` CHANGELOG headings). Patch bumps of peers cascade as patches and never trigger this. **Prevented since 2026-10-13** by `"onlyUpdatePeerDependentsWhenOutOfRange": true` in `.changeset/config.json` (`workspace:*` peers are always in range). If a release still lands a peer-dependent on `1.0.0`, check that option first.
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
- [ ] `git -C .release/arki-mirror log --oneline -2` → new release commit on top of the previous one, and equal to `git -C .release/arki-mirror ls-remote origin main`
- [ ] `git ls-remote git@github.com:arki-labs/arki.git refs/tags/<tag>` → tag exists on remote
- [ ] Source monorepo commit pushed (Coolify, internal CI, etc. may consume it)
