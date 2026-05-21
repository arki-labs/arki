# Sync `arki-labs/arki` with the materialized public tree

The GitHub mirror at `git@github.com:arki-labs/arki.git` is a force-pushed mirror of `.release/arki-public/`. Whenever source changes that should appear publicly, sync.

## Architectural model

```
.release/arki-public/   (deterministic regen target)
        │
        ▼
    git init  (every sync — repo is one-commit-per-ship, NOT incremental)
        │
        ▼
   force-push  ──►  arki-labs/arki main
        │
        ▼
   git tag v<ver>  ──►  push tag
```

**Key decision:** the public repo is treated as a **mirror, not a development branch**. Each ship rewrites `main` with a fresh single commit reflecting the current tree state. No PRs, no merges, no incremental history. This matches the deterministic-regen doctrine: the source of truth is the monorepo + materializer, not the mirror.

## Standard sync sequence

```bash
# 1. Make sure the public tree is current
bun tooling/arki-release/src/cli.ts export-public

# 2. Run scorecard — must report OPEN before any push
bun tooling/arki-release/src/cli.ts scorecard | tail -5

# 3. Init a fresh git history in the public tree
#    (the .release/arki-public/.git from a previous sync is wiped by export-public)
cd /Users/afurculita/Developer/workspace/.release/arki-public
git init -b main
git config user.name "Alexandru Furculita"
git config user.email "alex@furculita.net"
git config commit.gpgsign false
git add .

# 4. Commit
git commit -m "chore: <release description>

<multi-line release notes — packages, versions, what changed>"

# 5. Set remote + force-push
git remote add origin git@github.com:arki-labs/arki.git
git push --force origin main

# 6. Tag the release (annotated tag, multi-line message)
git tag -a v<version> -m "<release notes>"
git push origin v<version>

# 7. Return to workspace root
cd /Users/afurculita/Developer/workspace
```

## Updating a release tag

If a release tag needs to move (e.g., the v0.0.1 commit gets superseded by a content fix):

```bash
cd /Users/afurculita/Developer/workspace/.release/arki-public
git push origin :v0.0.1                 # delete remote tag
git tag -d v0.0.1 2>/dev/null || true   # delete local tag if it exists
git tag -a v0.0.1 -m "<updated notes>"
git push origin v0.0.1
```

## The CRITICAL gotcha — `git add -A` parent-walk

When running git commands inside `.release/arki-public/`, **always confirm a local `.git/` directory exists at that level** before running `git add -A` or any `git status`. Git walks UP the parent chain looking for a `.git/`, and if `.release/arki-public/.git/` doesn't exist, git uses the **monorepo's `.git/`** at `/Users/afurculita/Developer/workspace/.git/`. Then:

- `git status` shows the **monorepo's** status with paths like `../../apps/...`.
- `git add -A` stages every uncommitted change in the **whole monorepo**, including sibling agents' work.

**Recovery if you make this mistake:** the index pollution is reversible (`git reset HEAD <file>` per file), but per workspace rules you must NOT reset files outside your session log. The cleanest outcome is to commit only your own paths with `git -c commit.gpgsign=false commit <my-paths> -m "..."` and leave the rest of the index alone — sibling agents will rebuild their staging when they commit.

Verify before risky commands:

```bash
cd /Users/afurculita/Developer/workspace/.release/arki-public
git rev-parse --git-dir
# MUST print:  /Users/afurculita/Developer/workspace/.release/arki-public/.git
# If it prints the monorepo's .git, STOP — run `git init -b main` first.
```

## When the remote has existing content (first-time sync, or stale repo)

Before force-pushing, **clone the remote to a temp dir** and inspect what would be overwritten:

```bash
\rm -rf /tmp/arki-probe
git clone --depth 1 git@github.com:arki-labs/arki.git /tmp/arki-probe
ls -la /tmp/arki-probe
head /tmp/arki-probe/README.md
cd /tmp/arki-probe && git log -1 --format='%an %ad %s' && cd -
```

If the remote contains:
- **Your own abandoned attempt** (same author, old date, content you no longer want) — force-push is appropriate. Confirm with user before destructive remote action.
- **Anything you don't recognize** — STOP. Surface to user. Don't force-push without explicit authorization.
- **Empty / GitHub auto-init README** — force-push is safe.

## Verification after sync

```bash
# Did the push succeed?
cd /Users/afurculita/Developer/workspace/.release/arki-public
git log --oneline -1
# Compare with remote
git ls-remote origin main | awk '{print $1}'
# Should match. If not, the push didn't land.

# Are the tags right?
git ls-remote --tags origin
```
