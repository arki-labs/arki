# Sync `arki-labs/arki` with the materialized public tree

The GitHub mirror at `git@github.com:arki-labs/arki.git` holds one commit per release, on top of the previous one. Whenever source changes that should appear publicly, sync.

## Architectural model

```
.release/arki-public/   (deterministic regen target — export-public wipes it)
        │  rsync --delete (files only)
        ▼
.release/arki-mirror/   (a normal clone of arki-labs/arki — never wiped)
        │  commit on top of origin/main
        ▼
   git push  ──►  arki-labs/arki main   (plain push, never --force)
        │
        ▼
   git tag v<ver>  ──►  push tag (only if the tag does not exist yet)
```

**Key decision (founder, 2026-10-13):** the public repo is a **read-only mirror with history**: each ship adds one commit on top of the last, so clones keep working with `git pull` and GitHub shows what changed between releases. It is still not a development branch — no PRs or merges land there; the source of truth stays the monorepo + materializer. Until 2026-10-13 every ship was a fresh `git init` + force-push (one commit total); tags `v0.0.1`…`v0.4.1` still point at those old snapshot commits.

The checkout lives in `.release/arki-mirror/`, **beside** the export, because `export-public` deletes `.release/arki-public/` including any `.git` inside it. `.release/` is gitignored in the monorepo.

## Standard sync sequence

```bash
# 1. Make sure the public tree is current (workspaces-root mode, so cloners can `bun install`)
bun tooling/arki-release/src/cli.ts export-public

# 2. Run scorecard — must report OPEN before any push
bun tooling/arki-release/src/cli.ts scorecard | tail -5

# 3. Get the mirror checkout up to date (clone once, then reuse)
M=/Users/afurculita/Developer/workspace/.release/arki-mirror
[ -d "$M/.git" ] || git clone git@github.com:arki-labs/arki.git "$M"
cd "$M"
test "$(git rev-parse --show-toplevel)" = "$PWD" || { echo "not the mirror checkout — STOP"; exit 1; }
git fetch origin --tags
git checkout -f -B main origin/main   # -f: leftovers from an aborted sync would block a plain checkout;
                                      # the clone is disposable and step 4 rebuilds every file

# 4. Replace the files with the fresh export (removes files that left the tree)
rsync -a --delete --exclude .git ../arki-public/ ./

# 5. Commit on top and push — a plain push; a rejection means someone else pushed: fetch, redo 3–5
git add -A
git -c user.name="Alexandru Furculita" -c user.email="alex@furculita.net" -c commit.gpgsign=false \
  commit -m "release: <packages and versions>

<multi-line release notes — packages, versions, what changed>"
git push origin main

# 6. Tag the release (annotated) — skip if `git tag -l v<version>` already prints it;
#    tags are shared across packages and published tags never move
git tag -a v<version> -m "<release notes>"
git push origin v<version>

# 7. Return to workspace root
cd /Users/afurculita/Developer/workspace
```

If `git add -A` stages nothing, the public tree did not change since the last sync — skip the commit.

## Check the diff before committing

`export-public` reads a snapshot of **HEAD** by default (since 2026-10-13): packages, the root `package.json` and `arki.release.config.ts` come from the last commit, so a sibling session's uncommitted work never reaches the export. `dist/` comes from the working tree only for packages whose non-Markdown files match HEAD; the others are exported without it and listed as `EXPORT_E006` warnings. `--from-working-tree` restores the old behaviour.

Committed-but-unreleased work still exports (e.g. a version bump committed before its npm publish). After step 4, read `git diff --cached --stat` and confirm every changed package is part of this release. If other packages show up, commit only yours with a temporary index, on top of `origin/main` (seen 2026-10-13: the money release would otherwise have deleted `packages/event-sourcing` and published an unreleased `resilience` bump):

```bash
cd /Users/afurculita/Developer/workspace/.release/arki-mirror
export GIT_INDEX_FILE=/tmp/arki-mirror.index      # leaves the clone's own index alone
git read-tree origin/main
git add packages/<name>                            # repeat per released package
git diff --cached --stat origin/main               # only your packages
c=$(git commit-tree "$(git write-tree)" -p origin/main -m "release: @arki/<name> <version>")
unset GIT_INDEX_FILE
git push origin "$c":refs/heads/main               # still a plain fast-forward push
```

## Updating a release tag

Moving a published tag rewrites what cloners see; do it only with explicit founder approval. If a release tag needs to move (e.g., the v0.0.1 commit gets superseded by a content fix):

```bash
cd /Users/afurculita/Developer/workspace/.release/arki-mirror
git push origin :v0.0.1                 # delete remote tag
git tag -d v0.0.1 2>/dev/null || true   # delete local tag if it exists
git tag -a v0.0.1 -m "<updated notes>"
git push origin v0.0.1
```

## The CRITICAL gotcha — `git add -A` parent-walk

Every git command for the mirror runs in `.release/arki-mirror/`, never in `.release/arki-public/` (which has no `.git`). Git walks UP the parent chain looking for a `.git/`; in a folder without one it uses the **monorepo's `.git/`** at `/Users/afurculita/Developer/workspace/.git/`. Then:

- `git status` shows the **monorepo's** status with paths like `../../apps/...`.
- `git add -A` stages every uncommitted change in the **whole monorepo**, including sibling agents' work.

The `test "$(git rev-parse --show-toplevel)" = "$PWD"` guard in step 3 catches this. Keep it.

**Recovery if you make this mistake:** the index pollution is reversible (`git reset HEAD <file>` per file), but per workspace rules you must NOT reset files outside your session log. The cleanest outcome is to commit only your own paths with `git -c commit.gpgsign=false commit <my-paths> -m "..."` and leave the rest of the index alone — sibling agents will rebuild their staging when they commit.

## When the push is rejected

A plain `git push` fails if `origin/main` moved since your fetch. Never answer with `--force`. Fetch, inspect what landed (`git log --oneline main..origin/main`), and if it is a release you don't recognize, STOP and surface it to the user. Otherwise rerun steps 3–5; the rsync makes the result depend only on the export, not on what was there.

## Verification after sync

```bash
cd /Users/afurculita/Developer/workspace/.release/arki-mirror
git log --oneline -3                       # your release on top of the previous one
git ls-remote origin main | awk '{print $1}'
# Must equal `git rev-parse HEAD`. If not, the push didn't land.

git ls-remote --tags origin                # are the tags right?
```
